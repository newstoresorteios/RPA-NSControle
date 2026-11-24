/**
 * Thin entry: delegates to NSControle CWS Rastro status sync.
 * Prefer running from NSControle repo; this wrapper helps cron layouts that start here.
 *
 *   node scripts/correios-status-sync.mjs [--mock] [--limit N]
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const nscontrole = resolve(here, "../../NSControle");
const script = resolve(nscontrole, "scripts/correios-status-sync.mjs");
if (!existsSync(script)) {
  console.error(`NSControle sync script not found at ${script}`);
  console.error("Clone/run from deploy-prod/NSControle or set sibling path.");
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ["--env-file=.env.local", script, ...process.argv.slice(2)],
  { cwd: nscontrole, stdio: "inherit", env: process.env },
);
process.exit(result.status ?? 1);
