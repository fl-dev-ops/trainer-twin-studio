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
      data: { json: { slug: seed().twin.slug, name: original.name, description: original.description ?? "", settings: original.settings } },
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
