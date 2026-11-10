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

  test("a refused start posts once through the countdown; Try again explicitly retries", async ({ page }) => {
    const { org, codes } = seed();
    let attempts = 0;
    const refusal = "You need at least 5 minutes to start a call; you have 3. Ask your trainer for more.";
    await page.route("**/api/sessions", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      attempts++;
      await route.fulfill({ status: 403, json: { error: refusal, code: "minutes" } });
    });
    await page.goto(e2eUrl(org.slug, `/s/${codes.learner}`));
    await page.getByRole("button", { name: "Join session", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Get ready" })).toBeVisible();
    await expect(page.getByText(refusal, { exact: true })).toBeVisible();
    expect(attempts).toBe(1);
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await expect.poll(() => attempts).toBe(2);
    await expect(page.getByText(refusal, { exact: true })).toBeVisible();
    expect(attempts).toBe(2);
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
