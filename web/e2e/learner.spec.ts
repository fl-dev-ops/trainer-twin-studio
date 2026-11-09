import { expect, test } from "@playwright/test";
import { e2eUrl } from "./env";
import { as, seed } from "./seed-data";

test.describe("a learner with credits", () => {
  test.use(as("learner"));

  test("the org home lists their role play; its link shows the minutes they have", async ({ page }) => {
    const { org, codes } = seed();
    await page.goto(e2eUrl(org.slug));
    await expect(page.getByRole("heading", { name: "Your role plays" })).toBeVisible();
    await expect(page.getByText("Pitch practice")).toBeVisible();

    await page.goto(e2eUrl(org.slug, `/s/${codes.learner}`));
    await expect(page.getByText("30 min of practice left · the call ends when they run out")).toBeVisible();
  });
});

test.describe("a learner out of credits", () => {
  test.use(as("broke"));

  test("their link says they're out of minutes", async ({ page }) => {
    const { org, codes } = seed();
    await page.goto(e2eUrl(org.slug, `/s/${codes.broke}`));
    await expect(page.getByText("Out of practice minutes")).toBeVisible();
  });
});
