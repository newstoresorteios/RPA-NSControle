# RPA-NSControle-correios

Standalone Playwright RPA for the Correios **Portal Importador**: login → search by tracking → Path A/B (boleto) or Path C (entregues comprovante) → upsert into the **NSControle Neon** tables `ctl_correios_*` (and related `ctl_orders` fields).

Migrated from `NSControle` feature branches (`cursor/correios-tax-tables-*`, `cursor/boleto-pending-fastfail-*`, `cursor/sept-alfandega-gap-*`).

## Setup

```bash
cp .env.example .env.local
# fill DATABASE_URL / DATABASE_URL_UNPOOLED / CORREIOS_USER / CORREIOS_PASSWORD
# for status sync also: CORREIOS_API_USER / CORREIOS_API_TOKEN (CWS access code, not JWT)
npm install
```

Node 20+. Playwright Chromium is installed via `postinstall` (or run `npx playwright install chromium`).

Never commit `.env` / `.env.local` or real credentials.

## Paths (Portal)

| Path | When | Script |
|------|------|--------|
| **A** | First boleto issue (`$` icon) | `correios-rpa-smoke.mjs` |
| **B** | Re-entry / already processing (sandwich → Pagar) | same smoke (auto-fallback) |
| **C** | Already delivered (Imprimir comprovante) | `correios-rpa-entregues.mjs` |

Details: [docs/plano-rpa-correios.md](docs/plano-rpa-correios.md).

## Common commands

```bash
# Path A/B smoke for one tracking
npm run smoke -- LX335304323JP

# Hourly Path A/B queue (Neon pending → smoke, bounded)
# HOURLY_LIMIT=12 by default; GitHub Actions cron uses this
npm run hourly
# npm run hourly -- --limit 5

# CWS Rastro status sync (API → Neon ctl_orders tracking_* / delivered)
npm run status-sync
# npm run status-sync -- --limit 40
# npm run status-sync -- --mock

# Path C single / batch
npm run entregues -- LW061145525US
npm run entregues -- --batch --from storage/entregues/entregues-trackings.json

# Resume Entregues batch until done
npm run entregues:batch

# September alfândega gaps (Path C then A/B)
npm run fill-gaps -- --from storage/sept-gaps/trackings.json --dir storage/sept-gaps

# Helpers
npm run copiar-once -- <TRACKING>
npm run imprimir-once -- <TRACKING> [pagamentoId]
npm run recover -- <BOLETO_URL> [TRACKING]
npm run parse-entregues -- "C:\\path\\to\\planilha.xlsx"
npm run neon-paid

# Migrations (against Neon)
npm run migrate -- scripts/migrations/20261104_ctl_correios_taxas.sql
npm run migrate:boleto-pending
```

Artifacts land under `media/` (screenshots/results) and `storage/boletos/` (PDFs). Override screenshots with `SMOKE_MEDIA_DIR`.

## Layout

```
scripts/                  RPA entrypoints + helpers
scripts/lib/              pagfacil capture / PDF parse
scripts/migrations/       ctl_correios_* SQL
storage/boletos|entregues|sept-gaps/
media/                    smoke screenshots / JSON results
docs/                     Path A/B/C plan + project context
```

## GitHub Actions (every 15 min)

Two workflows share the dense cron pattern `0/15/30/45 * * * *` (UTC) + `workflow_dispatch`. GitHub may still delay scheduled runs; four cron entries give more fire opportunities than a single hourly cron.

| Workflow | Job | Command |
|----------|-----|---------|
| `.github/workflows/correios-hourly.yml` | Portal Importador Path A/B | `npm run hourly` |
| `.github/workflows/correios-status-sync.yml` | CWS Rastro → Neon status/delivered | `npm run status-sync` |

### Path A/B secrets (names only)

`DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `CORREIOS_USER`, `CORREIOS_PASSWORD`. Workflow forces `HEADED=0`.

### Status sync secrets (names only)

Required: `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `CORREIOS_API_USER`, `CORREIOS_API_TOKEN`.

Optional: `CORREIOS_API_CARTAO`, `CORREIOS_API_CONTRATO`, `CORREIOS_API_DR`, `CORREIOS_API_URL`.

`CORREIOS_API_TOKEN` = **código de acesso CWS** (access code), **not** a JWT and **not** the Portal site password (`CORREIOS_PASSWORD`).

Status sync uses `npm ci --ignore-scripts` (no Playwright). Schema needs `ctl_orders.tracking_checked_at` (migration `scripts/migrations/20261124_ctl_orders_tracking_checked_at.sql`). Panel spreadsheet columns live in NSControle — DB updates work from this script alone once those columns exist.

## Security

- Portal password, CWS access code, and Neon URLs: env / Actions secrets only
- Keep Portal (`CORREIOS_USER` / `CORREIOS_PASSWORD`) separate from CWS API (`CORREIOS_API_USER` / `CORREIOS_API_TOKEN`)
