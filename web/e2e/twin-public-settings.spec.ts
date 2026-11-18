import { expect, test } from "@playwright/test";
import { z } from "zod";
import { as, seed } from "./seed-data";
import { e2eUrl } from "./env";

const settingsSchema = z.object({
  result: z.object({ data: z.object({ json: z.object({
    publicAccess: z.object({ enabled: z.boolean(), maxSeconds: z.union([z.literal(60), z.literal(120), z.literal(180), z.literal(300)]) }),
    widget: z.object({
      id: z.string(),
      config: z.object({ enabled: z.boolean(), allowedOrigins: z.array(z.string()), welcome: z.string(), accentColor: z.string() }),
    }),
  }) }) }),
});
type Settings = z.infer<typeof settingsSchema>["result"]["data"]["json"];

test.describe.serial("public and embed settings layout", () => {
  test.use(as("admin"));
  let original: Settings;
  test.beforeAll(async ({ request }) => {
    const response = await request.get(e2eUrl("dash", `/api/twin/agents.get?input=${encodeURIComponent(JSON.stringify({ json: { slug: seed().twin.slug } }))}`));
    expect(response.ok()).toBe(true);
    original = settingsSchema.parse(await response.json()).result.data.json;
  });
  test.afterAll(async ({ request }) => {
    if (!original) return;
    const response = await request.post(e2eUrl("dash", "/api/twin/agents.update"), {
      data: { json: { slug: seed().twin.slug, publicAccess: original.publicAccess, widget: original.widget.config } },
    });
    expect(response.ok()).toBe(true);
  });
  test.beforeEach(async ({ page }) => {
    await page.goto(e2eUrl("dash", `/twin/${seed().twin.slug}/edit`));
  });

  test("public duration uses shared rows and explicit save/cancel", async ({ page }, testInfo) => {
    await page.getByRole("tab", { name: "Public access", exact: true }).click();
    const panel = page.getByRole("tabpanel", { name: "Public access", exact: true });
    await expect(panel.getByRole("region", { name: "Public voice calls", exact: true })).toBeVisible();
    await expect(panel.locator('[data-slot="card"]')).toHaveCount(0);
    const duration = panel.getByLabel("Maximum call duration", { exact: true });
    const before = await duration.inputValue();
    const next = before === "60" ? "120" : "60";
    await duration.selectOption(next);
    await panel.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(duration).toHaveValue(before);
    await duration.selectOption(next);
    const saved = page.waitForResponse((response) => response.url().includes("agents.update") && response.request().method() === "POST");
    await panel.getByRole("button", { name: "Save", exact: true }).click();
    expect((await saved).ok()).toBe(true);
    await expect(panel.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await page.reload();
    await page.getByRole("tab", { name: "Public access", exact: true }).click();
    await expect(duration).toHaveValue(next);
    await page.screenshot({ path: testInfo.outputPath("public-access-desktop.png"), animations: "disabled" });
  });

  test("embed drafts cancel, validate and persist without starting a call", async ({ page }, testInfo) => {
    let starts = 0;
    page.on("request", (request) => { if (new URL(request.url()).pathname.startsWith("/api/public/")) starts++; });
    await page.getByRole("tab", { name: "Embed", exact: true }).click();
    const panel = page.getByRole("tabpanel", { name: "Embed", exact: true });
    const origins = panel.getByLabel("Allowed website origins", { exact: true });
    const welcome = panel.getByLabel("Welcome message", { exact: true });
    const colour = panel.getByLabel("Accent colour", { exact: true });
    await expect(panel.getByRole("region", { name: "Website widget", exact: true })).toBeVisible();
    await expect(panel.locator('[data-slot="card"]')).toHaveCount(0);
    await origins.fill("https://example.com");
    await welcome.fill("Try this twin");
    await colour.fill("#27533f");
    await panel.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(origins).toHaveValue(original.widget.config.allowedOrigins.join("\n"));
    await expect(welcome).toHaveValue(original.widget.config.welcome);
    await expect(colour).toHaveValue(original.widget.config.accentColor);
    await origins.fill("https://example.com/path");
    await panel.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText(/Use an exact HTTPS origin without/i).first()).toBeVisible();
    await origins.fill("https://example.com\nhttps://www.example.com");
    await welcome.fill("Talk to our twin");
    await colour.fill("#27533f");
    const saved = page.waitForResponse((response) => response.url().includes("agents.update") && response.request().method() === "POST");
    await panel.getByRole("button", { name: "Save", exact: true }).click();
    expect((await saved).ok()).toBe(true);
    await expect(panel.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await page.reload();
    await page.getByRole("tab", { name: "Embed", exact: true }).click();
    await expect(welcome).toHaveValue("Talk to our twin");
    await expect(colour).toHaveValue("#27533f");
    await expect(origins).toHaveValue("https://example.com\nhttps://www.example.com");
    expect(starts).toBe(0);
    await page.screenshot({ path: testInfo.outputPath("embed-desktop.png"), animations: "disabled" });
  });

  test("install actions copy the unchanged ID and both snippets", async ({ page }) => {
    await page.getByRole("tab", { name: "Embed", exact: true }).click();
    await page.evaluate(() => {
      Object.defineProperty(navigator.clipboard, "writeText", {
        configurable: true,
        value: async (text: string) => { sessionStorage.setItem("copied-widget-value", text); },
      });
    });
    const install = page.getByRole("region", { name: "Install", exact: true });
    await install.getByRole("button", { name: "Copy ID", exact: true }).click();
    expect(await page.evaluate(() => sessionStorage.getItem("copied-widget-value"))).toBe(original.widget.id);
    for (const [name, mode] of [["Floating launcher", "floating"], ["Inline panel", "inline"]]) {
      await install.getByRole("region", { name, exact: true }).getByRole("button", { name: "Copy snippet", exact: true }).click();
      const copied = await page.evaluate(() => sessionStorage.getItem("copied-widget-value"));
      expect(copied).toContain(`data-twin-id="${original.widget.id}"`);
      expect(copied).toContain(`data-mode="${mode}"`);
      expect(copied).toContain("/widgets/v1.js");
    }
  });

  test("both tabs fit a narrow viewport", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const tab of ["Public access", "Embed"]) {
      await page.getByRole("tab", { name: tab, exact: true }).click();
      const panel = page.getByRole("tabpanel", { name: tab, exact: true });
      await expect(panel.getByRole("button", { name: "Save", exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const box = await panel.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeLessThanOrEqual(390);
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(390);
      await page.screenshot({ path: testInfo.outputPath(`${tab === "Embed" ? "embed" : "public-access"}-mobile.png`), animations: "disabled" });
    }
  });
});
