// Load environment variables before any module reads process.env.
//
// Bun loads .env automatically in its own directory, but when running across a
// monorepo or from a subshell, we want deterministic fallbacks:
// 1. bench/.env (local overrides for the harness, e.g. ephemeral CHROMA_URL)
// 2. web/.env (the production app credentials, e.g. OPENROUTER_API_KEY)
//
// We do this sync at the very top of the entrypoint, before any imports because
// those read process.env at module-evaluation time.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webEnvPath = resolve(here, "../../../web/.env");
const benchEnvPath = resolve(here, "../../.env");

function parseEnv(raw: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, val] = match;
    let cleanVal = val.trim();
    if (
      (cleanVal.startsWith('"') && cleanVal.endsWith('"')) ||
      (cleanVal.startsWith("'") && cleanVal.endsWith("'"))
    ) {
      cleanVal = cleanVal.slice(1, -1);
    }
    env[key] = cleanVal;
  }
  return env;
}

function load(path: string) {
  try {
    const parsed = parseEnv(readFileSync(path, "utf8"));
    for (const [k, v] of Object.entries(parsed)) {
      if (!process.env[k]) process.env[k] = v;
    }
  } catch {
    // missing .env is fine; environment might already be populated
  }
}

load(benchEnvPath);
load(webEnvPath);
