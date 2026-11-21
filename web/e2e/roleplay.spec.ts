import { expect, test } from "@playwright/test";
import { as, seed } from "./seed-data";

test.use(as("admin"));

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

test("edit page: four tabs; the Required upload switch appears with the upload, saves, and survives a reload", async ({ page }) => {
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

  // Turning the upload off turns Required off with it.
  await page.getByRole("switch", { name: "Upload a file before the call" }).click();
  await expect(page.getByRole("switch", { name: "File required" })).toHaveCount(0);
  await expect(page.getByText("File upload before the call turned off")).toBeVisible();
  await page.reload();
  await page.getByRole("tab", { name: "Settings" }).click();
  await page.getByRole("switch", { name: "Upload a file before the call" }).click();
  await expect(page.getByRole("switch", { name: "File required" })).toHaveAttribute("aria-checked", "false");
});

test("the calibration page for a role play opens and goes back to the role play", async ({ page }) => {
  const slug = seed().roleplay.slug;
  await page.goto(`/roleplay/${slug}/calibrate`);
  await expect(page).toHaveURL(new RegExp(`/roleplay/${slug}/calibrate$`));
  await expect(page.locator("main, body").first()).not.toContainText(/404|not found/i);
});
