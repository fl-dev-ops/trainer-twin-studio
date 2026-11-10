import { expect, test } from "@playwright/test";
import { as, seed } from "./seed-data";

test.use(as("admin"));

test("Credits: the org's remaining credits, learners' balances (searchable, paged), and Meteroid grants", async ({ page }) => {
  const { more, learner } = seed();
  await page.goto("/credits");
  // 500 granted by Meteroid; 30 + 1 + 22 × 10 given out.
  await expect(page.getByText("Remaining credits")).toBeVisible();
  await expect(page.locator("main").getByText("249 min", { exact: true })).toBeVisible();

  await expect(page.getByRole("tab", { name: "Assigned" })).toHaveAttribute("aria-selected", "true");
  const rows = page.locator("main ul li");
  await expect(rows).toHaveCount(20);
  await expect(page.getByText(`1–20 of ${more.length + 2}`)).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(rows).toHaveCount(more.length + 2 - 20);

  await page.getByLabel("Search learners").fill(learner.name);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("30");

  await page.getByRole("tab", { name: "Credits added" }).click();
  const topup = page.locator("main li").filter({ hasText: "Starting balance" });
  await expect(topup).toContainText("+500 min");
  await expect(topup).toContainText("TrainerTwin");
});
