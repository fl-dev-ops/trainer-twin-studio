import { expect, test } from "@playwright/test";
import { z } from "zod";
import { as, seed } from "./seed-data";
import { e2eUrl } from "./env";

const settingsSchema = z.object({
  result: z.object({ data: z.object({ json: z.object({
    name: z.string(),
    description: z.string().nullable(),
    settings: z.object({
      preScreenshare: z.boolean(), preUpload: z.boolean(), duringUpload: z.boolean(),
      uploadTitle: z.string(), uploadInstruction: z.string(),
    }),
    publicAccess: z.object({ enabled: z.boolean(), maxSeconds: z.union([z.literal(60), z.literal(120), z.literal(180), z.literal(300)]) }),
    widget: z.object({
      id: z.string(),
      config: z.object({ enabled: z.boolean(), allowedOrigins: z.array(z.string()), welcome: z.string(), accentColor: z.string() }),
    }),
  }) }) }),
});
type Settings = z.infer<typeof settingsSchema>["result"]["data"]["json"];

test.describe.serial("twin settings layout", () => {
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
      data: { json: { slug: seed().twin.slug, name: original.name, description: original.description ?? "", settings: original.settings, publicAccess: original.publicAccess, widget: original.widget.config } },
    });
    expect(response.ok()).toBe(true);
  });
  test.beforeEach(async ({ page }) => {
    await page.goto(e2eUrl("dash", `/twin/${seed().twin.slug}/edit`));
  });

  test("general details save explicitly and persist", async ({ page }, testInfo) => {
    const panel = page.getByRole("tabpanel", { name: "General", exact: true });
    await expect(panel.getByRole("region", { name: "Twin details", exact: true })).toBeVisible();
    await expect(panel.locator('[data-slot="card"]')).toHaveCount(0);
    let updates = 0;
    page.on("request", (request) => { if (request.url().includes("agents.update") && request.method() === "POST") updates++; });
    await panel.getByLabel("Bot name", { exact: true }).fill("Updated E2E Coach");
    const description = "Learn from real-world expertise in client communication, negotiation and closing deals. Discuss situations, practise your approach and get guidance grounded in experience. ".repeat(4).trim();
    await panel.getByLabel("Description", { exact: true }).fill(description);
    const nameBox = await panel.getByLabel("Bot name", { exact: true }).boundingBox();
    const descriptionBox = await panel.getByLabel("Description", { exact: true }).boundingBox();
    expect(descriptionBox!.width).toBeGreaterThan(600);
    expect(descriptionBox!.x).toBe(nameBox!.x);
    expect(updates).toBe(0);
    const saved = page.waitForResponse((response) => response.url().includes("agents.update") && response.request().method() === "POST");
    await panel.getByRole("button", { name: "Save changes", exact: true }).click();
    expect((await saved).ok()).toBe(true);
    await page.reload();
    await expect(panel.getByLabel("Bot name", { exact: true })).toHaveValue("Updated E2E Coach");
    await expect(panel.getByLabel("Description", { exact: true })).toHaveValue(description);
    await page.screenshot({ path: testInfo.outputPath("general-desktop.png"), animations: "disabled" });
  });

  test("conversation switches autosave while upload text retains save/cancel", async ({ page }, testInfo) => {
    await page.getByRole("tab", { name: "Conversation", exact: true }).click();
    const panel = page.getByRole("tabpanel", { name: "Conversation", exact: true });
    await expect(panel.getByRole("region", { name: "Before the conversation", exact: true })).toBeVisible();
    await expect(panel.locator('[data-slot="card"]')).toHaveCount(0);
    const upload = panel.getByRole("switch", { name: "Upload a file before the conversation", exact: true });
    if ((await upload.getAttribute("aria-checked")) !== "true") {
      const enabled = page.waitForResponse((response) => response.url().includes("agents.update") && response.request().method() === "POST");
      await upload.click();
      expect((await enabled).ok()).toBe(true);
    }
    const title = panel.getByLabel("Upload title", { exact: true });
    const instruction = panel.getByLabel("What to upload", { exact: true });
    const before = await title.inputValue();
    await title.fill("Unsaved heading");
    await panel.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(title).toHaveValue(before);
    await title.fill("Bring a brochure");
    await instruction.fill("Upload your current brief.");
    const saved = page.waitForResponse((response) => response.url().includes("agents.update") && response.request().method() === "POST");
    await panel.getByRole("button", { name: "Save", exact: true }).click();
    expect((await saved).ok()).toBe(true);
    const changed = new Map<string, string>();
    for (const label of ["Share screen before the conversation", "Attach a file during the conversation"]) {
      const toggle = panel.getByRole("switch", { name: label, exact: true });
      const next = (await toggle.getAttribute("aria-checked")) === "true" ? "false" : "true";
      const response = page.waitForResponse((value) => value.url().includes("agents.update") && value.request().method() === "POST");
      await toggle.click();
      expect((await response).ok()).toBe(true);
      changed.set(label, next);
    }
    await page.reload();
    await page.getByRole("tab", { name: "Conversation", exact: true }).click();
    await expect(upload).toHaveAttribute("aria-checked", "true");
    await expect(title).toHaveValue("Bring a brochure");
    await expect(instruction).toHaveValue("Upload your current brief.");
    for (const [label, checked] of changed) await expect(panel.getByRole("switch", { name: label, exact: true })).toHaveAttribute("aria-checked", checked);
    await page.screenshot({ path: testInfo.outputPath("conversation-desktop.png"), animations: "disabled" });
  });

  test("learner empty state and existing assignment dialog remain available", async ({ page }, testInfo) => {
    await page.getByRole("tab", { name: /^Learners/ }).click();
    const panel = page.getByRole("tabpanel", { name: /^Learners/ });
    await expect(panel.getByText("Nobody is assigned yet.", { exact: true })).toBeVisible();
    await expect(panel.locator('[data-slot="card"]')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("learners-desktop.png"), animations: "disabled" });
    await panel.getByRole("button", { name: "Assign learners", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Assign twin agent", exact: true })).toBeVisible();
    await expect(dialog.getByRole("searchbox", { name: "Search learners", exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toBeHidden();
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
    const publicUrl = panel.getByRole("region", { name: "Public URL", exact: true });
    const link = publicUrl.getByRole("link");
    await expect(link).toHaveAttribute("href", /^https:\/\/[^/]+\/t\/.+/);
    expect(await link.textContent()).toBe(await link.getAttribute("href"));
    await page.evaluate(() => {
      Object.defineProperty(navigator.clipboard, "writeText", {
        configurable: true,
        value: async (text: string) => { sessionStorage.setItem("copied-public-url", text); },
      });
    });
    await publicUrl.getByRole("button", { name: "Copy link", exact: true }).click();
    await expect(publicUrl.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem("copied-public-url"))).toBe(await link.getAttribute("href"));
    await page.screenshot({ path: testInfo.outputPath("public-access-desktop.png"), animations: "disabled" });
  });

  test("public URL loading failure offers retry without changing access", async ({ page }) => {
    const endpoint = "**/api/twin/agents.shareLink*";
    await page.route(endpoint, (route) => route.abort());
    await page.getByRole("tab", { name: "Public access", exact: true }).click();
    const panel = page.getByRole("tabpanel", { name: "Public access", exact: true });
    const toggle = panel.getByRole("switch", { name: "Allow anonymous visitors", exact: true });
    const enabled = await toggle.getAttribute("aria-checked");
    const publicUrl = panel.getByRole("region", { name: "Public URL", exact: true });
    await expect(publicUrl.getByRole("alert")).toHaveText("Could not load the public URL.");
    await page.unroute(endpoint);
    await publicUrl.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(publicUrl.getByRole("link")).toHaveAttribute("href", /^https:\/\/[^/]+\/t\/.+/);
    await expect(publicUrl.getByRole("alert")).toHaveCount(0);
    await expect(toggle).toHaveAttribute("aria-checked", enabled!);
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
      const code = install.getByRole("region", { name, exact: true }).locator("pre");
      await expect(code).toContainText("\n  src=");
      expect(await code.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    }
  });

  test("all tabs share a compact gap and fit a narrow viewport", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const tab of ["General", "Conversation", "Public access", "Embed", "Learners"]) {
      await page.getByRole("tab", { name: new RegExp(`^${tab}`) }).click();
      const panel = page.getByRole("tabpanel", { name: new RegExp(`^${tab}`) });
      await expect(panel.getByRole("region").first()).toBeVisible();
      await expect.poll(async () => {
        const tabs = await page.getByRole("tablist").boundingBox();
        const first = await panel.getByRole("region").first().boundingBox();
        if (!tabs || !first) return false;
        const gap = first.y - (tabs.y + tabs.height);
        return gap >= 12 && gap <= 24;
      }).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const box = await panel.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeLessThanOrEqual(390);
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(390);
      await page.screenshot({ path: testInfo.outputPath(`${tab.toLowerCase().replaceAll(" ", "-")}-mobile.png`), animations: "disabled" });
      if (tab === "Embed") {
        const install = panel.getByRole("region", { name: "Install", exact: true });
        for (const code of await install.locator("pre").all()) {
          expect(await code.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
        }
        await install.scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath("install-mobile.png"), animations: "disabled" });
      }
    }
  });
});
