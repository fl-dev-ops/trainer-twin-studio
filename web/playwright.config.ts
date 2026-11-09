import { defineConfig } from "@playwright/test";
import { E2E_PORT, e2eUrl } from "./e2e/env";

/**
 * Browser tests (bun run test:e2e): real Chrome against the app on the test database (port 3999). Start the server
 * once with bun run e2e:server and keep it running for fast reruns; otherwise this starts it. Each run seeds fresh
 * data and signs the test people in first (e2e/seed.setup.ts).
 */
export default defineConfig({
  testDir: "e2e",
  // The specs share the seeded org and some change it: one at a time.
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "e2e/.report" }]],
  outputDir: "e2e/.results",
  use: {
    baseURL: e2eUrl("dash"),
    channel: "chrome",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "setup", testMatch: /seed\.setup\.ts/ },
    { name: "chrome", dependencies: ["setup"], testMatch: /\.spec\.ts/ },
  ],
  webServer: {
    command: "bun e2e/server.ts",
    url: `http://localhost:${E2E_PORT}/api/auth/ok`,
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
