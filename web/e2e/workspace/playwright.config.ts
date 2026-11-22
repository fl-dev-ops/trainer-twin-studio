import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".", testMatch: "workspace.spec.ts", workers: 1, timeout: 60_000,
  expect: { timeout: 15_000 }, reporter: "list",
  outputDir: "../.results/workspace",
  use: { baseURL: "http://127.0.0.1:4174", channel: "chrome", trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: [
    { command: "bun e2e/server.ts", cwd: process.cwd(), url: "http://localhost:3999/api/auth/ok", reuseExistingServer: false, timeout: 180_000 },
    { command: "bun e2e/workspace/server.ts", cwd: process.cwd(), url: "http://127.0.0.1:4174", reuseExistingServer: false, timeout: 180_000 },
  ],
});
