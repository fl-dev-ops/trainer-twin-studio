import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { e2eUrl } from "./env";
import { openTwinBot } from "./bots";
import { as, seed } from "./seed-data";

const publicPath = () => `/t/${seed().twin.slug.replace(`${seed().org.slug}-`, "")}`;
const publicUrl = () => e2eUrl(seed().org.slug, publicPath());
const startPath = "**/api/public/twins/*/sessions";

async function settings(browser: Browser) {
  const context = await browser.newContext(as("admin"));
  const page = await context.newPage();
  await openTwinBot(page);
  return { context, page };
}

async function setEnabled(page: Page, enabled: boolean) {
  const toggle = page.getByRole("switch", { name: "Allow anonymous visitors", exact: true });
  if ((await toggle.getAttribute("aria-checked")) === String(enabled)) return;
  const saved = page.waitForResponse((response) => response.url().includes("bots.update") && response.request().method() === "POST");
  await toggle.click();
  const response = await saved;
  expect(response.ok(), await response.text()).toBe(true);
  await expect(toggle).toHaveAttribute("aria-checked", String(enabled));
}

async function prejoin(page: Page) {
  await page.goto(publicUrl());
  await page.getByRole("button", { name: "Start conversation", exact: true }).click();
  await expect(page.getByLabel("Your name", { exact: true })).toBeVisible();
}

async function fakeMicrophone(context: BrowserContext, denied = false) {
  await context.addInitScript((deny) => {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => {
        if (deny) throw new DOMException("Permission denied", "NotAllowedError");
        return new MediaStream();
      },
    });
  }, denied);
}

test.describe.serial("public twin phase 1", () => {
  test("public-off requires sign-in; studio settings save the enable switch and duration immediately", async ({ page, browser }) => {
    await page.goto(publicUrl());
    await page.getByRole("button", { name: "Start conversation", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("Sign in to talk");
    await expect(page.getByLabel("Your name", { exact: true })).toHaveCount(0);

    const studio = await settings(browser);
    try {
      const toggle = studio.page.getByRole("switch", { name: "Allow anonymous visitors", exact: true });
      await expect(toggle).toHaveAttribute("aria-checked", "false");
      await expect(studio.page.getByText(/paid from your organization’s balance/)).toBeVisible();
      await setEnabled(studio.page, true);
      const duration = studio.page.getByLabel("Maximum call duration", { exact: true });
      await expect(duration).toHaveValue("300");
      const saved = studio.page.waitForResponse((response) => response.url().includes("bots.update") && response.request().method() === "POST");
      await duration.selectOption("600");
      expect((await saved).ok()).toBe(true);
      await expect(studio.page.getByRole("region", { name: "Website bot settings", exact: true }).getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
      await studio.page.reload();
      await expect(toggle).toHaveAttribute("aria-checked", "true");
      await expect(duration).toHaveValue("600");
    } finally {
      await studio.context.close();
    }
  });

  test("prejoin never auto-starts, requires a valid self-reported name, and has no text or upload controls", async ({ page }, testInfo) => {
    let attempts = 0;
    page.on("request", (request) => { if (/\/api\/public\/twins\/[^/]+\/sessions$/.test(request.url())) attempts++; });
    await prejoin(page);
    await expect(page.getByText(/speaking with an AI twin/)).toBeVisible();
    await expect(page.getByText(/transcribed and may be recorded/)).toBeVisible();
    await expect(page.getByText(/Up to \d+ minutes/)).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("public-twin-prejoin.png"), fullPage: true });
    const name = page.getByLabel("Your name", { exact: true });
    const start = page.getByRole("button", { name: "Start voice call", exact: true });
    await expect(start).toBeDisabled();
    await name.fill("   ");
    await expect(start).toBeDisabled();
    await name.fill("Visitor\u0007");
    await start.click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText("without control characters");
    await expect(name).toHaveAttribute("maxlength", "80");
    await expect(page.getByRole("button", { name: /Type a message|Attach a file|Share screen/ })).toHaveCount(0);
    await expect(page.locator('input[type="file"], textarea')).toHaveCount(0);
    expect(attempts).toBe(0);
  });

  test("microphone denial happens before the public start API", async ({ page, context }) => {
    await fakeMicrophone(context, true);
    let attempts = 0;
    page.on("request", (request) => { if (/\/api\/public\/twins\/[^/]+\/sessions$/.test(request.url())) attempts++; });
    await prejoin(page);
    await page.getByLabel("Your name", { exact: true }).fill("Visitor");
    await page.getByRole("button", { name: "Start voice call", exact: true }).click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText("Microphone access was denied");
    await expect(page.getByRole("button", { name: "Start voice call", exact: true })).toBeEnabled();
    expect(attempts).toBe(0);
  });

  test("an explicitly started call sends a trimmed name once and shows a real backend refusal", async ({ page, context, browser }) => {
    await fakeMicrophone(context);
    await prejoin(page);
    await page.getByLabel("Your name", { exact: true }).fill("  Visitor Name  ");
    const studio = await settings(browser);
    try {
      await setEnabled(studio.page, false);
      const requests: string[] = [];
      page.on("request", (request) => { if (/\/api\/public\/twins\/[^/]+\/sessions$/.test(request.url())) requests.push(request.postData() ?? ""); });
      const response = page.waitForResponse((result) => /\/api\/public\/twins\/[^/]+\/sessions$/.test(result.url()));
      await page.getByRole("button", { name: "Start voice call", exact: true }).click();
      const refused = await response;
      expect(refused.ok()).toBe(false);
      const body: { error: string } = await refused.json();
      await expect(page.getByRole("main").getByRole("alert")).toHaveText(body.error);
      await expect(page.getByRole("button", { name: "Start voice call", exact: true })).toBeEnabled();
      expect(requests.map((body) => JSON.parse(body))).toEqual([{ name: "Visitor Name" }]);
    } finally {
      await setEnabled(studio.page, true);
      await studio.context.close();
    }
  });

  test("ending during an in-flight start does not reopen prejoin when its refusal arrives", async ({ page, context, browser }) => {
    await fakeMicrophone(context);
    await prejoin(page);
    const studio = await settings(browser);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let intercepted: () => void = () => undefined;
    const requested = new Promise<void>((resolve) => { intercepted = resolve; });
    await page.route(startPath, async (route) => {
      intercepted();
      await gate;
      await route.continue();
    });
    try {
      await setEnabled(studio.page, false);
      await page.getByLabel("Your name", { exact: true }).fill("Visitor");
      await page.getByRole("button", { name: "Start voice call", exact: true }).click();
      await requested;
      await expect(page.getByRole("button", { name: /Type a message|Attach a file|Share screen/ })).toHaveCount(0);
      await expect(page.locator('input[type="file"], textarea')).toHaveCount(0);
      await page.getByRole("button", { name: "End call", exact: true }).click();
      await expect(page.getByText("Call ended. Thank you for talking.", { exact: true })).toBeVisible();
      const response = page.waitForResponse((result) => /\/api\/public\/twins\/[^/]+\/sessions$/.test(result.url()));
      release();
      const refused = await response;
      expect(refused.ok()).toBe(false);
      await refused.finished();
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await expect(page.getByRole("button", { name: "Back to profile", exact: true })).toBeVisible();
      await expect(page.getByLabel("Your name", { exact: true })).toHaveCount(0);
      await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
    } finally {
      release();
      await setEnabled(studio.page, true);
      await studio.context.close();
    }
  });

  test("signed-in unassigned learners remain blocked despite public access", async ({ browser }) => {
    const context = await browser.newContext(as("learner"));
    try {
      const page = await context.newPage();
      await page.goto(publicUrl());
      await expect(page.getByRole("heading", { name: "This twin isn't yours yet", exact: true })).toBeVisible();
      await expect(page.getByLabel("Your name", { exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /Start voice call|Start conversation/ })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
