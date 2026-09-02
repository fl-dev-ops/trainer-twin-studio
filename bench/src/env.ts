// Loads ../web/.env into process.env (without overriding values already set).
// MUST be the first import in any entrypoint that pulls in web/lib modules —
// those read process.env at module-evaluation time.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webEnvPath = resolve(here, "../../web/.env");

try {
  const raw = readFileSync(webEnvPath, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
} catch {
  // Fall through: real env vars may already be set; required() errors surface later.
}

export const NOTION_PAGE_URL =
  "https://app.notion.com/p/CareerwithVasanth-Frontend-development-mastery-cohort-1-2f21199ccfe38090a0b5daf57d7d917c";
