/**
 * Portal Importador → tracking → boleto → Neon upsert.
 * Usage: node --env-file=.env.local scripts/correios-rpa-smoke.mjs [TRACKING...]
 * One browser session for every tracking on the command line.
 * Network resets are not stored as payment_status=error (the hourly queue retries them).
 * Never logs CORREIOS_PASSWORD. Does not set tax_paid=true on boleto generation.
 * Delivered / pagamento confirmado opens the receipt and may set tax_paid when an amount is read.
 *
 * Branching (Paulo):
 *   Path A — first issue: search → $ → ciência → Concluir → Boleto → pagfacil → Copiar
 *   Path B — re-entry:    search → sandwich → modal Pagar → Boleto → pagfacil → Copiar
 * Detection: try A first; if "Pagamento em Processamento" or empty barcode → B.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { chromium } from "playwright";
import { capturePagfacilBoleto } from "./lib/pagfacil-capture.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SEARCH_URL =
  "https://portalimportador.correios.com.br/pages/pesquisarRemessaImportador/pesquisarRemessaImportador.jsf";
const BOLETOS_DIR = join(ROOT, "storage", "boletos");
const HEADED = process.env.HEADED !== "0";
const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function parseTrackings(argv) {
  const args = argv.slice(2).map((s) => String(s || "").trim().toUpperCase()).filter(Boolean);
  return args.length ? args : ["LX335304323JP"];
}

const TRACKINGS = parseTrackings(process.argv);
let TRACKING = TRACKINGS[0];
const MEDIA_ROOT = process.env.SMOKE_MEDIA_DIR || join(ROOT, "media");
let MEDIA = join(MEDIA_ROOT, "smoke-" + TRACKING);

function isNetworkError(err) {
  const msg = String(err?.message || err || "");
  return /ERR_CONNECTION|ERR_TIMED_OUT|ERR_NETWORK|ERR_ABORTED|ERR_EMPTY_RESPONSE|net::|Target closed|Session closed|browser has been closed|Execution context was destroyed/i.test(msg);
}

function isTransientError(err) {
  const msg = String(err?.message || err || "");
  return isNetworkError(err) || /Timeout|Navigation failed|tracking input not found|result row not found|username field not found|password field not found/i.test(msg);
}

function loadEnv() {
  const values = { ...process.env };
  try {
    for (const line of readFileSync(join(ROOT, ".env.local"), "utf8").split(/\r?\n/)) {
      if (!line || line.startsWith("#") || !line.includes("=")) continue;
      const i = line.indexOf("=");
      const k = line.slice(0, i);
      if (values[k] == null || values[k] === "") values[k] = line.slice(i + 1);
    }
  } catch {
    /* ignore */
  }
  return values;
}

function parseMoney(text) {
  if (!text) return null;
  const m = String(text).replace(/\s/g, "").match(/R\$\s*([\d.]+,\d{2}|[\d]+(?:\.\d{2})?)/i)
    || String(text).match(/([\d.]+,\d{2})/);
  if (!m) return null;
  const raw = m[1].includes(",") ? m[1].replace(/\./g, "").replace(",", ".") : m[1];
  const n = Number(raw);
  return Number.isFinite(n) ? n.toFixed(2) : null;
}

async function readValorAPagar(page) {
  // Prefer labeled value / input — ignore "Simulação IBS/CBS"
  const byLabel = page.getByLabel(/Valor a Pagar/i);
  if (await byLabel.count()) {
    const v = (await byLabel.inputValue().catch(() => "")) || (await byLabel.innerText().catch(() => ""));
    const parsed = parseMoney(v) || parseMoney("R$ " + v);
    if (parsed) return parsed;
  }
  const inputNear = page.locator("xpath=//*[contains(.,'Valor a Pagar')]/following::input[1]");
  if (await inputNear.count()) {
    const v = await inputNear.first().inputValue().catch(() => "");
    const parsed = parseMoney(v) || parseMoney("R$ " + v);
    if (parsed) return parsed;
  }
  const block = page.locator("text=Valor a Pagar").locator("xpath=ancestor::*[self::div or self::td or self::tr][1]");
  if (await block.count()) {
    const t = await block.first().innerText().catch(() => "");
    // strip simulation lines then parse
    const cleaned = t.replace(/Simula[cç][aã]o[\s\S]*/i, "");
    const parsed = parseMoney(cleaned);
    if (parsed) return parsed;
  }
  const body = await page.locator("body").innerText();
  const m = body.match(/Valor a Pagar[:\s]*R\$\s*([\d.]+,\d{2})/i);
  if (m) return parseMoney("R$ " + m[1]);
  return null;
}

async function waitAguardeGone(page, ms = 60000) {
  const aguarde = page.locator("text=Aguarde").first();
  try {
    await aguarde.waitFor({ state: "hidden", timeout: ms });
  } catch {
    /* may never appear */
  }
  await page.locator(".ui-dialog:visible, .ui-widget-overlay:visible").first().waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
}

async function lookupPagfacilUrl(env) {
  const url = env.DATABASE_URL_UNPOOLED || env.DATABASE_URL;
  if (!url) return null;
  const sql = postgres(url, { ssl: "require", max: 1, prepare: false });
  try {
    const rows = await sql`
      select portal_order_id, raw_payload
      from ctl_correios_taxas
      where upper(trim(tracking_code)) = ${TRACKING}
      limit 1
    `;
    const row = rows[0];
    if (!row) return null;
    const payload = row.raw_payload || {};
    const pagamentoId =
      payload.pagamentoId ||
      (typeof payload.boletoUrl === "string" && payload.boletoUrl.match(/boletos\/([a-f0-9-]+)/i)?.[1]) ||
      null;
    if (pagamentoId) return `https://pagfacil.correios.com.br/boletos/${pagamentoId}/resumo`;
    if (payload.boletoUrl) return payload.boletoUrl;
    return null;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function shot(page, name) {
  mkdirSync(MEDIA, { recursive: true });
  const path = join(MEDIA, name);
  await page.screenshot({ path, fullPage: true });
  console.log("screenshot:", path);
  return path;
}

async function gotoRetry(page, url, attempts = 4) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      // commit survives Correios resets better than waiting for DOM on the first byte
      await page.goto(url, { waitUntil: "commit", timeout: 45000 });
      await page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});
      const body = await page.locator("body").innerText().catch(() => "");
      if (/ERR_CONNECTION|n[aã]o [eé] poss[ií]vel acessar/i.test(body)) {
        throw new Error("net::ERR_CONNECTION_RESET chrome error page");
      }
      return;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`goto retry ${i}/${attempts}:`, msg.slice(0, 160));
      const reset = /ERR_CONNECTION|ERR_TIMED_OUT|net::|Timeout/i.test(msg);
      await page.waitForTimeout(reset ? 8000 * i : 2000 * i);
    }
  }
  throw lastErr;
}

async function launchBrowser() {
  const opts = {
    headless: !HEADED,
    args: ["--disable-popup-blocking", "--disable-http2"],
  };
  try {
    return await chromium.launch({ ...opts, channel: "chrome" });
  } catch {
    return await chromium.launch(opts);
  }
}

function contextOptions() {
  return {
    acceptDownloads: true,
    locale: "pt-BR",
    viewport: { width: 1400, height: 900 },
    userAgent: CHROME_UA,
    permissions: ["clipboard-read", "clipboard-write"],
  };
}

async function tryComprovante(page, context, tracking) {
  const row = page.locator("table tbody tr, tr").filter({ hasText: tracking }).first();
  if (!(await row.count())) return null;
  const icons = row.locator("td").first().locator("a:visible, button:visible, span.ui-button:visible");
  if (!(await icons.count())) return null;
  await icons.nth(0).click({ force: true });
  await page.waitForTimeout(1200);
  await waitAguardeGone(page, 20000);
  const imprimir = page.getByRole("button", { name: /Imprimir comprovante/i })
    .or(page.locator('button:has-text("Imprimir comprovante"), a:has-text("Imprimir comprovante")'))
    .first();
  let text = "";
  if (await imprimir.count()) {
    const popupPromise = context.waitForEvent("page", { timeout: 20000 }).catch(() => null);
    await imprimir.click({ force: true });
    const popup = await popupPromise;
    const target = popup || page;
    await target.waitForLoadState("domcontentloaded").catch(() => {});
    text = await target.locator("body").innerText().catch(() => "");
    if (popup) await popup.close().catch(() => {});
  } else {
    text = await page.locator("body").innerText().catch(() => "");
  }
  await page.getByRole("button", { name: /^Fechar$/i }).click({ force: true }).catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});
  const digits = String(text).replace(/\D/g, "");
  const candidate = (digits.match(/\d{47,48}/g) || []).find((value) =>
    /^(237|341|033|001|104|748|422|077|756|041|389)/.test(value),
  );
  return {
    amount: parseMoney(text),
    linha: candidate ? candidate.slice(0, 47) : null,
  };
}

async function upsertDb(env, payload) {
  const url = env.DATABASE_URL_UNPOOLED || env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL ausente");
  const sql = postgres(url, { ssl: "require", max: 1, prepare: false });
  try {
    const orders = await sql`
      select id, order_key, label, tracking_code, import_tax, tax_paid
      from ctl_orders
      where upper(trim(tracking_code)) = ${TRACKING}
      limit 2
    `;
    const order = orders[0] || null;
    const run = await sql`
      insert into ctl_correios_scrape_runs (status, items_seen, items_upserted, boletos_saved, error_summary, finished_at)
      values (
        ${payload.ok ? "success" : "partial"},
        1,
        ${payload.taxAmount ? 1 : 0},
        ${payload.pdfPath ? 1 : 0},
        ${payload.error || null},
        now()
      )
      returning id
    `;
    const runId = run[0].id;

    const status = payload.paymentStatus || (payload.pdfPath || payload.linha ? "boleto_generated" : "awaiting_payment");

    const taxRows = await sql`
      insert into ctl_correios_taxas (
        order_id, tracking_code, portal_order_id, tax_amount, payment_status,
        due_date, linha_digitavel, pdf_path, raw_payload, scrape_run_id, last_scraped_at
      ) values (
        ${order?.id ?? null},
        ${TRACKING},
        ${payload.portalOrderId || null},
        ${payload.taxAmount},
        ${status},
        ${payload.dueDate || null},
        ${payload.linha || null},
        ${payload.pdfPath || null},
        ${sql.json(payload.raw || {})},
        ${runId},
        now()
      )
      on conflict (tracking_code) do update set
        order_id = coalesce(excluded.order_id, ctl_correios_taxas.order_id),
        portal_order_id = coalesce(excluded.portal_order_id, ctl_correios_taxas.portal_order_id),
        tax_amount = coalesce(excluded.tax_amount, ctl_correios_taxas.tax_amount),
        payment_status = excluded.payment_status,
        due_date = coalesce(excluded.due_date, ctl_correios_taxas.due_date),
        linha_digitavel = coalesce(excluded.linha_digitavel, ctl_correios_taxas.linha_digitavel),
        pdf_path = coalesce(excluded.pdf_path, ctl_correios_taxas.pdf_path),
        raw_payload = coalesce(ctl_correios_taxas.raw_payload, '{}'::jsonb) || excluded.raw_payload,
        scrape_run_id = excluded.scrape_run_id,
        last_scraped_at = now(),
        updated_at = now()
      returning id, order_id, tracking_code, tax_amount, payment_status, linha_digitavel, pdf_path
    `;
    const tax = taxRows[0];

    let boleto = null;
    if (payload.linha || payload.pdfPath) {
      const existing = payload.linha
        ? await sql`select id from ctl_correios_boletos where linha_digitavel = ${payload.linha} limit 1`
        : [];
      if (existing[0]) {
        boleto = (
          await sql`
            update ctl_correios_boletos set
              tax_id = ${tax.id},
              order_id = coalesce(${order?.id ?? null}, order_id),
              amount = coalesce(${payload.taxAmount}, amount),
              pdf_path = coalesce(${payload.pdfPath || null}, pdf_path),
              pdf_sha256 = coalesce(${payload.pdfSha || null}, pdf_sha256),
              downloaded_at = now()
            where id = ${existing[0].id}
            returning id, tax_id, order_id, linha_digitavel, amount, pdf_path
          `
        )[0];
      } else {
        boleto = (
          await sql`
            insert into ctl_correios_boletos (
              tax_id, order_id, tracking_code, linha_digitavel, amount, due_date, pdf_path, pdf_sha256
            ) values (
              ${tax.id}, ${order?.id ?? null}, ${TRACKING}, ${payload.linha || null},
              ${payload.taxAmount}, ${payload.dueDate || null}, ${payload.pdfPath || null}, ${payload.pdfSha || null}
            )
            returning id, tax_id, order_id, linha_digitavel, amount, pdf_path
          `
        )[0];
      }
    }

    if (order && payload.taxAmount) {
      await sql`
        update ctl_orders set
          tax_identified_at = coalesce(tax_identified_at, now()),
          import_tax = ${payload.taxAmount},
          tax_paid = case when ${payload.taxPaid === true} then true else tax_paid end,
          notes_robot = case
            when notes_robot is null or notes_robot = '' then ${payload.note}
            when notes_robot like ${"%" + payload.note + "%"} then notes_robot
            else left(notes_robot || E'\n' || ${payload.note}, 2000)
          end
        where id = ${order.id}
      `;
      // intentionally NOT setting tax_paid=true for boleto_generated
    }

    return { order, tax, boleto, runId };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function main() {
  const env = loadEnv();
  const user = env.CORREIOS_USER;
  const pass = env.CORREIOS_PASSWORD;
  if (!user || !pass) {
    console.error("FAIL: CORREIOS_USER / CORREIOS_PASSWORD missing in env");
    process.exit(2);
  }
  console.log("tracking:", TRACKINGS.join(","));
  console.log("user_set: yes len=" + user.length);
  console.log("headed:", HEADED);
  mkdirSync(BOLETOS_DIR, { recursive: true });
  mkdirSync(MEDIA, { recursive: true });

  let browser = await launchBrowser();
  let context = await browser.newContext(contextOptions());
  await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
  let page = await context.newPage();

  async function loginPage(target) {
    const loginUrl =
      "https://cas.correios.com.br/login?service=" +
      encodeURIComponent(SEARCH_URL);
    await gotoRetry(target, loginUrl);
    await shot(target, "01-login.png");

    const userSel = [
      'input[name="username"]',
      "#username",
      'input[type="text"]',
      'input[name="usuario"]',
    ];
    const passSel = [
      'input[name="password"]',
      "#password",
      'input[type="password"]',
    ];
    let filled = false;
    for (const us of userSel) {
      const el = target.locator(us).first();
      if (await el.count()) {
        await el.fill(user);
        filled = true;
        break;
      }
    }
    if (!filled) throw new Error("username field not found");
    let passFilled = false;
    for (const ps of passSel) {
      const el = target.locator(ps).first();
      if (await el.count()) {
        await el.fill(pass);
        passFilled = true;
        break;
      }
    }
    if (!passFilled) throw new Error("password field not found");

    const submit = target.locator(
      'button[type="submit"], input[type="submit"], button:has-text("LOGIN"), button:has-text("Entrar"), input[value*="LOGIN" i]',
    ).first();
    await submit.click();
    await target.waitForLoadState("domcontentloaded", { timeout: 60000 });
    await target.waitForTimeout(2000);
    await shot(target, "02-after-login.png");

    const bodyText = await target.locator("body").innerText().catch(() => "");
    if (/captcha|recaptcha|desafio|código de segurança/i.test(bodyText) && /password|senha|login/i.test(bodyText)) {
      await shot(target, "02b-captcha.png");
      throw new Error("CAPTCHA or login challenge detected");
    }
    if (/usu[aá]rio ou senha inv[aá]lid|authentication failed|credenciais/i.test(bodyText) && target.url().includes("login")) {
      throw new Error("login failed (invalid credentials?)");
    }

    const searchLink = target.locator('a[href*="pesquisarRemessaImportador"]').first();
    if (await searchLink.count() && await searchLink.isVisible().catch(() => false)) {
      await searchLink.click({ force: true }).catch(() => {});
      await target.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});
    }
    const landed = await target.locator("body").innerText().catch(() => "");
    if (!target.url().includes("pesquisarRemessaImportador") || /ERR_|não é possível acessar/i.test(landed)) {
      await gotoRetry(target, SEARCH_URL);
      await target.waitForTimeout(1500);
    }

    for (let i = 0; i < 3; i++) {
      const entendi = target.getByRole("button", { name: /^Entendi$/i })
        .or(target.locator('button:has-text("Entendi"), input[value="Entendi"], a:has-text("Entendi")'))
        .first();
      if (await entendi.count()) {
        const visible = await entendi.isVisible().catch(() => false);
        if (visible) {
          await entendi.click({ force: true });
          await target.waitForTimeout(800);
          console.log("dismissed modal: Entendi");
        } else break;
      } else break;
    }
    await target.keyboard.press("Escape").catch(() => {});
    await target.waitForTimeout(400);
    await shot(target, "03-search-page.png");
  }

  async function recoverSession() {
    console.log("session_recover");
    await page.waitForTimeout(12000).catch(() => {});
    await browser.close().catch(() => {});
    browser = await launchBrowser();
    context = await browser.newContext(contextOptions());
    await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
    page = await context.newPage();
    await loginPage(page);
  }

  try {
    await loginPage(page);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const credential = /CAPTCHA|invalid credentials|login failed/i.test(msg);
    for (const code of TRACKINGS) {
      const line = JSON.stringify({ tracking: code, error: msg.slice(0, 300) });
      if (credential) console.error("SMOKE_FAIL", line);
      else console.log("SMOKE_RETRY", line);
    }
    if (credential) process.exitCode = 1;
    await browser.close().catch(() => {});
    return;
  }

  let transientStreak = 0;
  try {
    for (let index = 0; index < TRACKINGS.length; index++) {
      TRACKING = TRACKINGS[index];
      MEDIA = join(MEDIA_ROOT, "smoke-" + TRACKING);
      mkdirSync(MEDIA, { recursive: true });
      console.log("tracking:", TRACKING, `${index + 1}/${TRACKINGS.length}`);
      const result = {
        ok: false,
        taxAmount: null,
        linha: null,
        pdfPath: null,
        pdfSha: null,
        portalOrderId: null,
        dueDate: null,
        paymentStatus: "error",
        taxPaid: false,
        error: null,
        note: `smoke ${TRACKING} ${new Date().toISOString().slice(0, 10)}`,
        raw: {},
      };

      try {
        if (index > 0) {
          for (const extra of context.pages()) {
            if (extra !== page) await extra.close().catch(() => {});
          }
          await gotoRetry(page, SEARCH_URL, 3);
          const entendiAgain = page.getByRole("button", { name: /^Entendi$/i }).first();
          if (await entendiAgain.count() && await entendiAgain.isVisible().catch(() => false)) {
            await entendiAgain.click({ force: true }).catch(() => {});
          }
          await page.keyboard.press("Escape").catch(() => {});
        }
        // Fill tracking search — visible text input under Pesquisar Encomenda
    const labeled = page.getByLabel(/c[oó]digo da encomenda/i);
    if (await labeled.count()) {
      await labeled.fill(TRACKING);
    } else {
      const boxes = page.locator('input[type="text"]:visible');
      const n = await boxes.count();
      let done = false;
      for (let i = 0; i < n; i++) {
        const box = boxes.nth(i);
        const meta =
          ((await box.getAttribute("placeholder")) || "") +
          ((await box.getAttribute("id")) || "") +
          ((await box.getAttribute("name")) || "");
        if (/encomenda|objeto|rastre|codigo|código|remessa/i.test(meta) || (n === 1 && i === 0)) {
          await box.fill(TRACKING);
          done = true;
          if (/encomenda|objeto|rastre|remessa/i.test(meta)) break;
        }
      }
      if (!done && n > 0) await boxes.first().fill(TRACKING);
      if (!done && n === 0) throw new Error("tracking input not found");
    }

    // Click visible Pesquisar button (avoid hidden JSF form field)
    const searchBtn = page.locator('input[type="submit"][value*="Pesquisar" i]:visible, button:visible:has-text("Pesquisar")').first();
    if (await searchBtn.count()) {
      await searchBtn.click();
    } else {
      // PrimeFaces / JSF often uses <button> or <a> styled as button
      const alt = page.locator("text=Pesquisar").locator("xpath=ancestor-or-self::*[self::button or self::a or self::span][1]").first();
      await alt.click({ force: true });
    }
    await page.waitForTimeout(2500);
    await shot(page, "04-search-result.png");

    const resultText = await page.locator("body").innerText();
    result.raw.searchSnippet = resultText.slice(0, 1500);

    if (!/Aguardando Pagamento/i.test(resultText)) {
      // Terminal / non-Path-A/B situations — skip boleto work; count as handled for hourly.
      const delivered =
        /Entregue ao Destinat[aá]rio/i.test(resultText) ||
        /Encomenda Entregue/i.test(resultText);
      const paymentConfirmed = /Pagamento Confirmado/i.test(resultText);
      const paidLike =
        paymentConfirmed ||
        /\bpago\b|\bquitad/i.test(resultText);
      const notFound = /n[aã]o encontr|sem registro|nenhum registro/i.test(resultText);

      if (delivered || paymentConfirmed) {
        let receipt = null;
        try {
          receipt = await tryComprovante(page, context, TRACKING);
        } catch (e) {
          if (isTransientError(e)) throw e;
          console.log("comprovante_skip", String(e?.message || e).slice(0, 140));
        }
        const situation = delivered ? "delivered" : "payment_confirmed";
        result.raw.situation = situation;
        if (receipt?.amount) {
          result.taxAmount = receipt.amount;
          result.linha = receipt.linha;
          result.paymentStatus = "paid";
          result.taxPaid = true;
          result.note = `smoke ${TRACKING}: ${situation} comprovante amount=${receipt.amount}`;
        } else if (delivered) {
          result.paymentStatus = "no_action";
          result.note = `smoke ${TRACKING}: delivered (Entregue) — comprovante sem valor; status=no_action`;
        } else {
          result.paymentStatus = "paid";
          result.note = `smoke ${TRACKING}: paid/confirmado — comprovante sem valor; status=paid`;
        }
        result.error = null;
      } else if (paidLike) {
        result.paymentStatus = "paid";
        result.raw.situation = "paid";
        result.note = `smoke ${TRACKING}: paid/confirmado — skip Path A/B; status=paid`;
        result.error = null;
      } else if (notFound) {
        result.paymentStatus = "not_found";
        result.raw.situation = "not_found";
        result.note = `smoke ${TRACKING}: not_found on portal — skip Path A/B`;
        result.error = `situation not Aguardando Pagamento (status=not_found)`;
      } else if (/Documento vinculado|Fiscaliza[cç]|Aguardando an[aá]lise/i.test(resultText)) {
        result.paymentStatus = "pending";
        result.raw.situation = "in_progress";
        result.note = `smoke ${TRACKING}: still moving on the portal — status=pending`;
        result.error = null;
      } else {
        result.paymentStatus = "no_action";
        result.raw.situation = "other";
        result.note = `smoke ${TRACKING}: situation not Aguardando Pagamento — skip Path A/B; status=no_action`;
        result.error = `situation not Aguardando Pagamento (status=no_action)`;
      }

      result.ok = true;
      result.taxAmount = result.taxAmount || parseMoney(resultText);
      const db = await upsertDb(env, result);
      writeFileSync(join(MEDIA, "result.json"), JSON.stringify({ result, db }, null, 2));
      console.log("DB:", JSON.stringify(db, null, 2));
      console.log("RESULT:", JSON.stringify({ ...result, pass: undefined }, null, 2));
      console.log("SMOKE_OK", JSON.stringify({
        tracking: TRACKING,
        taxAmount: result.taxAmount,
        linha: result.linha,
        pdfPath: result.pdfPath,
        paymentStatus: result.paymentStatus,
        situation: result.raw.situation || null,
        terminal: true,
        orderId: db.order?.id || null,
        taxId: db.tax?.id || null,
        boletoId: db.boleto?.id || null,
      }));
      transientStreak = 0;
      continue;
    }

    result.paymentStatus = "awaiting_payment";

    // Ação icons: [0]=hamburger/sandwich, [1]=eye, [2]=$
    // Path A (first issue): $ → ciência → Concluir → Boleto → pagfacil → Copiar
    // Path B (already issued): sandwich → modal Pagar → Boleto → pagfacil → Copiar
    // Detection: try A first; on "Pagamento em Processamento" / empty barcode → B
    const row = page.locator("table tbody tr, tr").filter({ hasText: TRACKING }).first();
    if (!(await row.count())) throw new Error("result row not found for tracking");
    await row.scrollIntoViewIfNeeded().catch(() => {});

    async function refreshActionClickables() {
      const cell = row.locator("td").first();
      return cell.locator("a:visible, button:visible, span.ui-button:visible");
    }

    async function clickSandwichThenPagar(shotName = "05b-modal-sandwich.png") {
      const icons = await refreshActionClickables();
      const n = await icons.count();
      console.log("path_B sandwich icons:", n);
      if (n < 1) throw new Error("no action icons for sandwich");
      await icons.nth(0).click({ force: true }); // hamburger — NOT $
      await page.waitForTimeout(1500);
      await shot(page, shotName);
      const dialogPagar = page.locator(".ui-dialog:visible").getByRole("button", { name: /^Pagar$/i })
        .or(page.locator('.ui-dialog:visible button:has-text("Pagar"), .ui-dialog:visible a:has-text("Pagar")'))
        .first();
      const anyPagar = page.getByRole("button", { name: /^Pagar$/i })
        .or(page.locator('.ui-dialog button:has-text("Pagar"), button:has-text("Pagar")'))
        .first();
      if (await dialogPagar.count()) await dialogPagar.click({ force: true });
      else if (await anyPagar.count()) await anyPagar.click({ force: true });
      else throw new Error("modal Pagar not found after sandwich");
      console.log("Path B: sandwich → modal Pagar");
      await waitAguardeGone(page, 60000);
      await page.waitForTimeout(1500);
    }

    async function clickDollarIcon() {
      const icons = await refreshActionClickables();
      const n = await icons.count();
      const payInRow = row.locator(
        'a[title*="pagament" i], a[aria-label*="pagament" i], a[title*="$"], button[title*="pagament" i], img[title*="pagament" i], a[onclick*="pagament" i]',
      );
      if (await payInRow.count()) {
        await payInRow.first().click({ force: true });
        return;
      }
      if (n >= 3) await icons.nth(2).click({ force: true });
      else if (n >= 1) await icons.nth(n - 1).click({ force: true });
      else throw new Error("payment ($) action not found");
      console.log("Path A: $ clicked");
    }

    async function closeDialogs() {
      const fechar = page.getByRole("button", { name: /^Fechar$/i });
      if (await fechar.count()) await fechar.click({ force: true }).catch(() => {});
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(400);
    }

    // --- Path A first ---
    let entryPath = "path_A_dollar";
    await clickDollarIcon();
    await page.waitForTimeout(1500);
    const procModal = page.getByText(/Pagamento em Processamento/i);
    if (await procModal.count()) {
      await shot(page, "05-pagamento-em-processamento.png");
      await closeDialogs();
      console.log("Path A blocked (Pagamento em Processamento) → Path B");
      await clickSandwichThenPagar("05b-modal-sandwich.png");
      entryPath = "path_B_sandwich";
    }
    result.raw.entryPath = entryPath;

    await waitAguardeGone(page, 30000);
    await page.waitForTimeout(1500);
    await shot(page, "05-efetuar-pagamento.png");

    // Shared: ciência → Concluir → Boleto → pagfacil → Copiar código / PDF
    async function runThroughBoletoAndCapture(shotPrefix) {
      // Shared tail after landing on Efetuar Pagamento (ciência → Concluir → Boleto → pagfacil)
      const boxes = page.locator('input[type="checkbox"]:visible');
      if (await boxes.count()) {
        const box = boxes.first();
        if (!(await box.isChecked())) {
          await box.check({ force: true }).catch(async () => {
            await page.locator("label").filter({ hasText: /Estou ciente/i }).click({ force: true });
          });
        }
      } else {
        await page.getByText(/Estou ciente/i).click({ force: true }).catch(() => {});
      }
      await waitAguardeGone(page, 30000);
      await page.waitForTimeout(800);
      const valor = await readValorAPagar(page);
      if (valor) result.taxAmount = valor;
      console.log("valor_a_pagar:", result.taxAmount);

      const concluir = page.getByRole("button", { name: /Concluir pagamento/i })
        .or(page.locator('button:has-text("Concluir pagamento"), input[value*="Concluir pagamento" i], a:has-text("Concluir pagamento")'))
        .first();
      if (!(await concluir.count()) || !(await concluir.isVisible().catch(() => false))) {
        await page.locator("label").filter({ hasText: /Estou ciente/i }).click({ force: true }).catch(() => {});
        await page.waitForTimeout(800);
      }
      // Listen for pagfacil popup before Concluir (Path B may open it directly)
      const popupPromise = context.waitForEvent("page", { timeout: 45000 }).catch(() => null);
      await concluir.click({ timeout: 15000 });
      await waitAguardeGone(page, 60000);
      await page.waitForTimeout(2000);
      await shot(page, `${shotPrefix}-after-concluir.png`);

      let boletoPage = page;
      const popup = await popupPromise;
      if (popup) {
        await popup.waitForLoadState("domcontentloaded").catch(() => {});
        boletoPage = popup;
        console.log("pagfacil popup after Concluir:", popup.url());
      }

      // Already on pagfacil? (Path B often skips method picker)
      const onPagfacil =
        /pagfacil\.correios|\/boletos\//i.test(boletoPage.url()) ||
        (await boletoPage.getByText(/Copiar c[oó]digo de barras|Pagar boleto|Imprimir Boleto/i).count().catch(() => 0)) > 0 ||
        (await page.getByText(/Copiar c[oó]digo de barras|Pagar boleto|Imprimir Boleto/i).count().catch(() => 0)) > 0;
      if (onPagfacil) {
        if (!/pagfacil|boletos/i.test(boletoPage.url()) && /pagfacil|boletos/i.test(page.url())) boletoPage = page;
        // Prefer page that has Copiar
        if (!(await boletoPage.getByText(/Copiar c[oó]digo de barras/i).count())) {
          if (await page.getByText(/Copiar c[oó]digo de barras/i).count()) boletoPage = page;
        }
        console.log("already on pagfacil — skip Boleto picker");
        return capturePagfacilBoleto(boletoPage, context, {
          tracking: TRACKING,
          boletosDir: BOLETOS_DIR,
          mediaDir: MEDIA,
          shotPrefix: `${shotPrefix}-pagfacil`,
        });
      }

      await shot(page, `${shotPrefix}-forma-pagamento.png`);
      const boletoCard = page.locator("div, button, a, label, li").filter({ hasText: /^Boleto Banc[aá]rio/i }).first();
      const boletoText = page.getByText(/Boleto Banc[aá]rio/i).first();
      if (await boletoCard.count()) await boletoCard.click({ force: true });
      else if (await boletoText.count()) await boletoText.click({ force: true });
      else throw new Error("Boleto Bancário option not found");
      await page.waitForTimeout(1500);
      await shot(page, `${shotPrefix}-boleto-selected.png`);

      const popupPromise2 = context.waitForEvent("page", { timeout: 45000 }).catch(() => null);
      const pagarModal = page.getByRole("button", { name: /^Pagar$/i })
        .or(page.locator('.ui-dialog button:has-text("Pagar"), button:has-text("Pagar")'))
        .first();
      if (await pagarModal.count()) {
        await pagarModal.click({ force: true });
        console.log("clicked Deseja Pagar com Boleto? → Pagar");
      }
      const popup2 = await popupPromise2;
      if (popup2) {
        await popup2.waitForLoadState("domcontentloaded").catch(() => {});
        boletoPage = popup2;
        console.log("boleto popup url:", popup2.url());
      } else {
        await page.waitForTimeout(2500);
        if (/pagfacil|boleto/i.test(page.url())) boletoPage = page;
      }

      return capturePagfacilBoleto(boletoPage, context, {
        tracking: TRACKING,
        boletosDir: BOLETOS_DIR,
        mediaDir: MEDIA,
        shotPrefix: `${shotPrefix}-pagfacil`,
      });
    }

    let captured = await runThroughBoletoAndCapture(entryPath === "path_B_sandwich" ? "08b" : "08a");

    // Empty barcode after Path A: keep the amount. Do not walk back to search
    // when the portal already refused to issue the boleto — that click timed out
    // and aborted the rest of the hourly queue.
    if (!captured.linha && !captured.pdfPath && entryPath === "path_A_dollar" && !captured.portalNotIssued) {
      console.log("Path A pagfacil empty barcode → fallback Path B (sandwich)");
      await shot(page, "08a-empty-barcode.png");
      try {
        for (const extra of context.pages()) {
          if (extra !== page) await extra.close().catch(() => {});
        }
        await gotoRetry(page, SEARCH_URL);
        await page.waitForTimeout(1000);
        const entendi2 = page.getByRole("button", { name: /^Entendi$/i });
        if (await entendi2.count()) await entendi2.click({ force: true }).catch(() => {});
        const labeled2 = page.getByLabel(/c[oó]digo da encomenda/i);
        if (await labeled2.count()) await labeled2.fill(TRACKING);
        else {
          const boxes2 = page.locator('input[type="text"]:visible');
          if (await boxes2.count()) await boxes2.first().fill(TRACKING);
        }
        const searchBtn2 = page.locator('input[type="submit"][value*="Pesquisar" i]:visible, button:visible:has-text("Pesquisar")').first();
        if (await searchBtn2.count()) await searchBtn2.click({ force: true, timeout: 8000 });
        await page.waitForTimeout(2500);
        await shot(page, "04b-research-pathB.png");
        await clickSandwichThenPagar("05c-modal-sandwich-fallback.png");
        entryPath = "path_B_sandwich_fallback";
        result.raw.entryPath = entryPath;
        await waitAguardeGone(page, 30000);
        await page.waitForTimeout(1000);
        await shot(page, "05c-efetuar-pagamento.png");
        captured = await runThroughBoletoAndCapture("08b");
      } catch (pathBErr) {
        console.log("Path B fallback skipped:", String(pathBErr?.message || pathBErr).slice(0, 160));
        if (!result.taxAmount && isNetworkError(pathBErr)) throw pathBErr;
      }
    } else if (captured.portalNotIssued) {
      console.log("Path A boleto not issued — keep amount, skip Path B");
    }

    result.taxAmount = result.taxAmount || captured.amount;
    result.linha = captured.linha;
    result.pdfPath = captured.pdfPath;
    result.pdfSha = captured.pdfSha;
    result.portalOrderId = captured.portalOrderId || result.portalOrderId;
    result.dueDate = captured.dueDate || result.dueDate;
    result.raw.afterSnippet = captured.bodySnippet;
    result.raw.finalUrl = captured.finalUrl;
    result.raw.pagamentoId = captured.pagamentoId;
    result.raw.urlBoleto = captured.urlBoleto;
    result.raw.entryPath = entryPath;

    if (result.pdfPath || result.linha) result.paymentStatus = "boleto_generated";
    else if (result.taxAmount && (captured.portalNotIssued || captured.paymentStatusHint === "boleto_pending")) result.paymentStatus = "boleto_pending";
    else result.paymentStatus = "awaiting_payment";
    result.ok = Boolean(result.taxAmount || result.linha);
    result.note = `smoke ${TRACKING}: path=${entryPath} valor=${result.taxAmount || "?"} status=${result.paymentStatus} linha=${result.linha ? "yes" : "no"} pdf=${result.pdfPath ? "yes" : "no"}`;

    const db = await upsertDb(env, result);
    writeFileSync(join(MEDIA, "result.json"), JSON.stringify({ result, db }, null, 2));
    console.log("DB:", JSON.stringify(db, null, 2));
    console.log("SMOKE_OK", JSON.stringify({
      tracking: TRACKING,
      taxAmount: result.taxAmount,
      linha: result.linha,
      pdfPath: result.pdfPath,
      paymentStatus: result.paymentStatus,
      orderId: db.order?.id || null,
      taxId: db.tax?.id || null,
      boletoId: db.boleto?.id || null,
    }));
        transientStreak = 0;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.error = msg;
        result.ok = false;
        if (result.taxAmount) {
          result.paymentStatus = result.linha || result.pdfPath ? "boleto_generated" : "boleto_pending";
          result.ok = true;
          result.error = null;
          result.note = `smoke ${TRACKING}: kept amount ${result.taxAmount} after ${msg.slice(0, 80)}`;
          try {
            const db = await upsertDb(env, result);
            console.log("DB:", JSON.stringify(db, null, 2));
            console.log("SMOKE_OK", JSON.stringify({
              tracking: TRACKING,
              taxAmount: result.taxAmount,
              linha: result.linha,
              pdfPath: result.pdfPath,
              paymentStatus: result.paymentStatus,
              orderId: db.order?.id || null,
              taxId: db.tax?.id || null,
              boletoId: db.boleto?.id || null,
            }));
          } catch (dbErr) {
            console.error("DB upsert failed:", dbErr instanceof Error ? dbErr.message : dbErr);
            console.log("SMOKE_RETRY", JSON.stringify({ tracking: TRACKING, error: msg.slice(0, 300) }));
          }
          transientStreak = 0;
          continue;
        }
        if (isNetworkError(err)) {
          transientStreak += 1;
          console.log("transient", TRACKING, `${transientStreak}/3`, msg.slice(0, 160));
          if (transientStreak >= 3) {
            console.log("SMOKE_RETRY", JSON.stringify({ tracking: TRACKING, error: msg.slice(0, 300) }));
            console.log("SMOKE_ABORT", JSON.stringify({ reason: "connection_reset_streak" }));
            for (let j = index + 1; j < TRACKINGS.length; j++) {
              console.log("SMOKE_RETRY", JSON.stringify({
                tracking: TRACKINGS[j],
                error: "aborted_after_connection_reset_streak",
              }));
            }
            break;
          }
          try {
            await recoverSession();
          } catch (loginErr) {
            const loginMsg = loginErr instanceof Error ? loginErr.message : String(loginErr);
            console.log("SMOKE_RETRY", JSON.stringify({ tracking: TRACKING, error: loginMsg.slice(0, 300) }));
            console.log("SMOKE_ABORT", JSON.stringify({ reason: "relogin_failed" }));
            for (let j = index + 1; j < TRACKINGS.length; j++) {
              console.log("SMOKE_RETRY", JSON.stringify({ tracking: TRACKINGS[j], error: "relogin_failed" }));
            }
            break;
          }
          index -= 1;
          continue;
        }
        await shot(page, "99-error.png").catch(() => {});
        try {
          const db = await upsertDb(env, result);
          writeFileSync(join(MEDIA, "result.json"), JSON.stringify({ result, db }, null, 2));
          console.log("DB:", JSON.stringify(db, null, 2));
        } catch (dbErr) {
          console.error("DB upsert failed:", dbErr instanceof Error ? dbErr.message : dbErr);
        }
        console.error("SMOKE_FAIL", JSON.stringify({ tracking: TRACKING, error: msg.slice(0, 300) }));
        process.exitCode = 1;
        transientStreak = 0;
      }
      await page.waitForTimeout(1200).catch(() => {});
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

main();
