// Guard: every exported handler under /api/v1 must call requireExternalApi
// (which runs auth.api.verifyApiKey — key lookup, expiry, rate limit, permission)
// on every request. Fails if a new handler forgets the guard.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../app/api/v1");

function routeFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? routeFiles(full) : full.endsWith("route.ts") ? [full] : [];
  });
}

let handlers = 0;
let guarded = 0;
for (const file of routeFiles(root)) {
  const source = readFileSync(file, "utf-8");
  for (const match of source.matchAll(/export async function (GET|POST|PATCH|DELETE|PUT)/g)) {
    handlers++;
    const after = source.slice(match.index, match.index + 400);
    assert.match(after, /requireExternalApi/, `${file}: ${match[1]} lacks requireExternalApi`);
    guarded++;
  }
}
assert.ok(handlers > 0, "no v1 handlers found");
console.log(`API guard check passed: ${guarded}/${handlers} handlers validated`);
