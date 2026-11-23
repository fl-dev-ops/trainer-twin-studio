import { expect, test } from "@playwright/test";
import { e2eUrl } from "./env";
import { as, seed } from "./seed-data";

test.use(as("namePrompt"));

test("an email-code learner can skip or save their name and it survives reload", async ({ page }) => {
  const url = e2eUrl(seed().org.slug);
  const prompt = page.getByRole("dialog", { name: "What should we call you?" });
  const sessionResponse = () => page.waitForResponse((response) => new URL(response.url()).pathname === "/api/auth/get-session");

  await page.goto(url);
  await expect(prompt).toBeVisible();
  await prompt.getByRole("button", { name: "Later" }).click();
  const skipped = sessionResponse();
  await page.reload();
  await skipped;
  await expect(prompt).not.toBeVisible();

  // A fresh browser has not skipped the prompt.
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(prompt).toBeVisible();
  await prompt.getByRole("button", { name: "Save" }).click();
  await expect(prompt.getByRole("alert")).toHaveText("Enter your name.");
  await prompt.getByPlaceholder("Your full name").fill("  Lena Example  ");
  await prompt.getByRole("button", { name: "Save" }).click();
  await expect(prompt).not.toBeVisible();

  const reloaded = sessionResponse();
  await page.reload();
  await reloaded;
  const saved = await page.request.get(e2eUrl(seed().org.slug, "/api/auth/get-session?disableCookieCache=true"));
  expect(saved.ok()).toBe(true);
  expect(await saved.json()).toMatchObject({ user: { name: "Lena Example" } });
  await expect(prompt).not.toBeVisible();
});
