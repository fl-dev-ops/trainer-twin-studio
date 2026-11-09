/**
 * The browser tests' dev server: bun run e2e:server (leave it running; bun run test:e2e reuses it), or started by
 * Playwright when it isn't up. Port 3999, test database, fake outside services (e2e/env.ts).
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { E2E_PORT, e2eServerEnv } from "./env";

// next dev rewrites this tracked file for its own build folder on start: put it back once it's up.
const tracked = ["next-env.d.ts"].map((path) => ({ path, text: readFileSync(path, "utf8") }));
const child = spawn("npx", ["next", "dev", "-p", String(E2E_PORT)], { stdio: "inherit", env: { ...process.env, ...e2eServerEnv() } });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 0));

for (let tries = 0; tries < 90; tries++) {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  if (await fetch(`http://localhost:${E2E_PORT}/api/auth/ok`).then((r) => r.ok, () => false)) break;
}
for (const file of tracked) if (readFileSync(file.path, "utf8") !== file.text) writeFileSync(file.path, file.text);
