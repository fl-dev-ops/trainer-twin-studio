import { expect, test, type Page } from "@playwright/test";
import { z } from "zod";
import { as, seed } from "./seed-data";
import { e2eUrl } from "./env";
import { openTwinBot } from "./bots";

const settingsSchema = z.object({
  result: z.object({ data: z.object({ json: z.object({
    name: z.string(),
    description: z.string().nullable(),
    settings: z.object({
      preScreenshare: z.boolean(), preUpload: z.boolean(), duringUpload: z.boolean(),
      uploadTitle: z.string(), uploadInstruction: z.string(),
    }),
    publicAccess: z.object({ enabled: z.boolean(), maxSeconds: z.union([z.literal(300), z.literal(600), z.literal(900), z.literal(1200), z.literal(1800)]) }),
    widget: z.object({
      id: z.string(),
      config: z.object({ enabled: z.boolean(), allowedOrigins: z.array(z.string()), welcome: z.string(), accentColor: z.string() }),
    }),
  }) }) }),
});
type Settings = z.infer<typeof settingsSchema>["result"]["data"]["json"];

const openBot = (page: Page) => openTwinBot(page);

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
    const { allowedOrigins, welcome, accentColor } = original.widget.config;
    const widget = { allowedOrigins, welcome, accentColor };
    const response = await request.post(e2eUrl("dash", "/api/twin/agents.update"), {
      data: { json: { slug: seed().twin.slug, name: original.name, description: original.description ?? "", settings: original.settings, publicAccess: original.publicAccess, widget } },
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
    expect(Math.round(descriptionBox!.x + descriptionBox!.width)).toBe(Math.round(nameBox!.x + nameBox!.width));
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
    // Earlier specs (people.spec) may assign this twin: the empty state shows only when nobody is.
    const empty = panel.getByText("Nobody is assigned yet.", { exact: true });
    const assignedRows = panel.getByRole("listitem");
    await expect(empty.or(assignedRows.first())).toBeVisible();
    await expect(panel.locator('[data-slot="card"]')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("learners-desktop.png"), animations: "disabled" });
    await panel.getByRole("button", { name: "Assign learners", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Assign twin agent", exact: true })).toBeVisible();
    await expect(dialog.getByRole("searchbox", { name: "Search learners", exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toBeHidden();
  });

  test("public duration saves as soon as it changes", async ({ page }, testInfo) => {
    await openBot(page);
    const panel = page.getByRole("region", { name: "Website bot settings", exact: true });
    await expect(panel.getByRole("region", { name: "Public voice calls", exact: true })).toBeVisible();
    await expect(panel.getByRole("region", { name: "Public URL", exact: true })).toHaveCount(0);
    await expect(panel.locator('[data-slot="card"]')).toHaveCount(0);
    const duration = panel.getByLabel("Maximum call duration", { exact: true });
    await expect(duration.locator("option")).toHaveText(["5 min", "10 min", "15 min", "20 min", "30 min"]);
    const next = (await duration.inputValue()) === "300" ? "600" : "300";
    const saved = page.waitForResponse((response) => response.url().includes("bots.update") && response.request().method() === "POST");
    await duration.selectOption(next);
    expect((await saved).ok()).toBe(true);
    await page.reload();
    await openBot(page);
    await expect(duration).toHaveValue(next);
    await page.screenshot({ path: testInfo.outputPath("public-access-desktop.png"), animations: "disabled" });
  });

  test("allowed websites are a draft that discards, validates and persists without starting a call", async ({ page }, testInfo) => {
    let starts = 0;
    page.on("request", (request) => { if (new URL(request.url()).pathname.startsWith("/api/public/")) starts++; });
    await openBot(page);
    const panel = page.getByRole("region", { name: "Website bot settings", exact: true });
    const access = panel.getByRole("switch", { name: "Allow anonymous visitors", exact: true });
    if ((await access.getAttribute("aria-checked")) === "false") {
      const enabled = page.waitForResponse((response) => response.url().includes("bots.update") && response.request().method() === "POST");
      await access.click();
      expect((await enabled).ok()).toBe(true);
    }
    const widget = panel.getByRole("region", { name: "Website widget", exact: true });
    const origins = widget.getByLabel("Allowed websites", { exact: true });
    await expect(widget.getByLabel("Welcome message", { exact: true })).toHaveCount(0);
    await expect(widget.getByLabel("Accent colour", { exact: true })).toHaveCount(0);
    await expect(widget.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
    await origins.fill("https://example.com");
    await expect(widget.getByText("Unsaved changes", { exact: true })).toBeVisible();
    await widget.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(origins).toHaveValue(original.widget.config.allowedOrigins.join("\n"));
    await expect(widget.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
    await origins.fill("https://example.com/path");
    await widget.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText(/Use an exact HTTPS origin without/i).first()).toBeVisible();
    await origins.fill("https://example.com\nhttps://www.example.com");
    const saved = page.waitForResponse((response) => response.url().includes("bots.update") && response.request().method() === "POST");
    await widget.getByRole("button", { name: "Save", exact: true }).click();
    expect((await saved).ok()).toBe(true);
    await expect(widget.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
    await page.reload();
    await openBot(page);
    await expect(origins).toHaveValue("https://example.com\nhttps://www.example.com");
    await expect(widget.getByRole("switch")).toHaveCount(0);
    await expect(widget.getByRole("status")).toHaveCount(0);
    expect(starts).toBe(0);
    await page.screenshot({ path: testInfo.outputPath("widget-desktop.png"), animations: "disabled" });
  });

  test("install copies the unchanged floating snippet", async ({ page }) => {
    await openBot(page);
    await page.evaluate(() => {
      Object.defineProperty(navigator.clipboard, "writeText", {
        configurable: true,
        value: async (text: string) => { sessionStorage.setItem("copied-widget-value", text); },
      });
    });
    const install = page.getByRole("region", { name: "Install", exact: true });
    await expect(install.getByRole("button", { name: "Copy ID", exact: true })).toHaveCount(0);
    await install.getByRole("button", { name: "Copy code", exact: true }).click();
    await expect(install.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
    const copied = await page.evaluate(() => sessionStorage.getItem("copied-widget-value"));
    // The embed id is the twin's bot once it exists (lib/bots), so read the current one.
    const current = await page.request.get(e2eUrl("dash", `/api/twin/agents.get?input=${encodeURIComponent(JSON.stringify({ json: { slug: seed().twin.slug } }))}`));
    expect(copied).toContain(`data-twin-id="${settingsSchema.parse(await current.json()).result.data.json.widget.id}"`);
    expect(copied).toContain('data-mode="floating"');
    expect(copied).toContain("/widgets/v1.js");
    const code = install.locator("pre");
    await expect(code).toContainText("\n  src=");
    expect(await code.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  });

  test("the sidebar's Website bot opens the bot's own page, apart from the twin's settings", async ({ page }) => {
    await expect(page.getByRole("tab", { name: "Public access", exact: true })).toHaveCount(0);
    await page.getByRole("link", { name: "Website bots", exact: true }).click();
    await expect(page).toHaveURL(/\/bots$/);
    await expect(page.getByRole("heading", { name: "Website bots" })).toBeVisible();
    await expect(page.getByRole("button", { name: "New bot", exact: true })).toBeVisible();
    await openBot(page);
    const panel = page.getByRole("region", { name: "Website bot settings", exact: true });
    await expect(panel.getByRole("region", { name: "Name and purpose", exact: true })).toBeVisible();
    await expect(panel.getByRole("region", { name: "Website widget", exact: true })).toBeVisible();
  });

  test("the website bot page fits a narrow viewport, install code included", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openBot(page);
    const panel = page.getByRole("region", { name: "Website bot settings", exact: true });
    await expect(panel.getByRole("region", { name: "Public voice calls", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const install = panel.getByRole("region", { name: "Install", exact: true });
    for (const code of await install.locator("pre").all()) {
      expect(await code.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    }
    await page.screenshot({ path: testInfo.outputPath("bot-mobile.png"), animations: "disabled" });
  });

  test("all tabs share a compact gap and fit a narrow viewport", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const tab of ["General", "Conversation", "Learners"]) {
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
    }
  });
});
