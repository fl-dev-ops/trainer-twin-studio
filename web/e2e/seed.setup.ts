import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { test as setup } from "@playwright/test";
import { E2E_BASE, e2eUrl } from "./env";

/**
 * Before the browser tests: fresh data (e2e/seed.ts), then each test person signed in through the app's own sign-in
 * API, their session saved for the tests (e2e/.auth/<who>.json). Signing in through the pages would go through the
 * https auth host, which this port doesn't serve.
 */
setup("seed and sign in", async () => {
  execFileSync("bun", ["e2e/seed.ts"], { stdio: "inherit" });
  const seed = JSON.parse(readFileSync("e2e/.state/seed.json", "utf8"));
  mkdirSync("e2e/.auth", { recursive: true });
  for (const who of ["admin", "learner", "broke"] as const) {
    const response = await fetch(e2eUrl("dash", "/api/auth/sign-in/email"), {
      method: "POST",
      // A trusted origin (lib/auth.ts trustedOrigins); the request itself goes to the test server.
      headers: { "content-type": "application/json", origin: `https://dash.${E2E_BASE}` },
      body: JSON.stringify({ email: seed[who].email, password: seed.password }),
    });
    if (!response.ok) throw new Error(`sign-in ${who}: ${response.status} ${await response.text()}`);
    const cookies = response.headers.getSetCookie().map((header) => {
      const [pair] = header.split(";");
      const [name, ...value] = pair.split("=");
      return { name, value: value.join("="), domain: `.${E2E_BASE}`, path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" as const };
    });
    writeFileSync(`e2e/.auth/${who}.json`, JSON.stringify({ cookies, origins: [] }));
  }
});
