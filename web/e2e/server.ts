/**
 * The browser tests' dev server: bun run e2e:server (leave it running; bun run test:e2e reuses it), or started by
 * Playwright when it isn't up. Port 3999, test database, fake outside services (e2e/env.ts).
 */
import { spawn } from "node:child_process";
import { E2E_PORT, e2eServerEnv } from "./env";

const child = spawn("npx", ["next", "dev", "-p", String(E2E_PORT)], { stdio: "inherit", env: { ...process.env, ...e2eServerEnv() } });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 0));
