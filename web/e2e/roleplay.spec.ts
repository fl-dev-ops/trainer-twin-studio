import { expect, test } from "@playwright/test";
import { e2eUrl } from "./env";
import { as, seed } from "./seed-data";

test.use(as("admin"));

test("the retired Domains bookmark is not a Studio route", async ({ page }) => {
  const response = await page.goto("/domains");
  expect(response?.status()).toBe(404);
  await expect(page).toHaveURL(/\/domains$/);
});

test("old /agents links land on the same role play under /roleplay", async ({ page }) => {
  const slug = seed().roleplay.slug;
  await page.goto("/agents");
  await expect(page).toHaveURL(/\/roleplay$/);
  await page.goto(`/agents/${slug}/edit`);
  await expect(page).toHaveURL(new RegExp(`/roleplay/${slug}/edit$`));
  await page.goto("/agents/fidelity");
  await expect(page).toHaveURL(/\/roleplay$/);
});

test("the library lists role plays only, and each card's menu edits, assigns and calibrates on /roleplay", async ({ page }) => {
  const slug = seed().roleplay.slug;
  await page.goto("/roleplay");
  await expect(page.getByRole("heading", { name: "Created role plays" })).toBeVisible();
  await expect(page.getByText("Interview scenarios")).toHaveCount(0);
  await expect(page.getByText("Pitch practice").first()).toBeVisible();
  await page.getByRole("button", { name: "Actions for Pitch practice" }).first().click();
  await expect(page.getByRole("menuitem", { name: "Edit" })).toHaveAttribute("href", `/roleplay/${slug}/edit`);
  await expect(page.getByRole("menuitem", { name: "Assign" })).toHaveAttribute("href", `/roleplay/${slug}/assign`);
  await expect(page.getByRole("menuitem", { name: "Calibrate" })).toHaveAttribute("href", `/roleplay/${slug}/calibrate`);
});

test("edit page: saved upload requirements control whether the learner can join", async ({ page, browser }) => {
  const slug = seed().roleplay.slug;
  await page.goto(`/roleplay/${slug}/edit`);
  for (const tab of ["General", "Persona", "Script", "Settings"]) await expect(page.getByRole("tab", { name: tab })).toBeVisible();
  await page.getByRole("tab", { name: "Settings" }).click();
  const upload = page.getByRole("switch", { name: "Upload a file before the call" });
  await expect(page.getByRole("switch", { name: "File required" })).toHaveCount(0);
  if ((await upload.getAttribute("aria-checked")) !== "true") await upload.click();
  await expect(upload).toHaveAttribute("aria-checked", "true");
  const required = page.getByRole("switch", { name: "File required" });
  await required.click();
  await expect(required).toHaveAttribute("aria-checked", "true");
  const knowledge = page.getByRole("switch", { name: "Knowledge search" });
  if ((await knowledge.getAttribute("aria-checked")) !== "true") await knowledge.click();
  await expect(knowledge).toHaveAttribute("aria-checked", "true");
  // Each switch saves on its own; wait until the last one is stored.
  await expect(page.getByText("Knowledge search turned on")).toBeVisible();

  await page.reload();
  await page.getByRole("tab", { name: "Settings" }).click();
  await expect(page.getByRole("switch", { name: "Upload a file before the call" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("switch", { name: "File required" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("switch", { name: "Knowledge search" })).toHaveAttribute("aria-checked", "true");

  const { org, codes } = seed();
  const learner = await browser.newPage(as("learner"));
  try {
    // The local S3 emulator has no bucket CORS policy. Forward the signed PUT to it and let Playwright supply CORS.
    await learner.route("http://127.0.0.1:9100/**/uploads/**", async (route) => {
      if (route.request().method() !== "PUT") return route.fallback();
      await route.fulfill({ response: await route.fetch() });
    });
    await learner.goto(e2eUrl(org.slug, `/s/${codes.learner}`));
    const documents = learner.getByRole("region", { name: "Documents" });
    const join = learner.getByRole("button", { name: "Join session", exact: true });
    const input = documents.locator('input[type="file"]');
    await expect(documents.getByText("Required", { exact: true })).toBeVisible();
    await expect(join).toBeDisabled();
    await input.setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("not a PDF or image") });
    await expect(documents.getByRole("alert")).toBeVisible();
    await expect(join).toBeDisabled();

    await input.setInputFiles({ name: "evidence.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64") });
    await expect(documents.getByText("Attached", { exact: true })).toBeVisible();
    await expect(join).toBeEnabled();
    await documents.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(join).toBeDisabled();
  } finally {
    await learner.close();
  }

  // Turning the upload off turns Required off with it.
  await page.getByRole("switch", { name: "Upload a file before the call" }).click();
  await expect(page.getByRole("switch", { name: "File required" })).toHaveCount(0);
  await expect(page.getByText("File upload before the call turned off")).toBeVisible();
  await page.reload();
  await page.getByRole("tab", { name: "Settings" }).click();
  await page.getByRole("switch", { name: "Upload a file before the call" }).click();
  await expect(page.getByRole("switch", { name: "File required" })).toHaveAttribute("aria-checked", "false");
  await expect(page.getByText("File upload before the call turned on")).toBeVisible();
  await page.getByRole("switch", { name: "Upload a file before the call" }).click();
  await expect(page.getByText("File upload before the call turned off")).toBeVisible();
});

test("calibration opens with the selected persona, without starting a call", async ({ page }) => {
  const slug = seed().roleplay.slug;
  await page.goto(`/roleplay/${slug}/calibrate`);
  await expect(page.getByRole("button", { name: "Start calibration" })).toBeVisible();
  await expect(page.getByText("Talk to E2E Trainer like a learner would, and rate each answer.")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/roleplay/${slug}/calibrate$`));
});
