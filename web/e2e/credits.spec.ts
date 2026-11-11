import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { as, seed } from "./seed-data";

test.use(as("admin"));

test("Usage: the org's remaining credits, Meteroid grants, and learners' balances (searchable, paged)", async ({ page }) => {
  const { more, learner } = seed();
  await page.goto("/credits"); // old link: redirects to Usage
  await expect(page).toHaveURL(/\/usage$/);
  // 500 granted by Meteroid; 30 + 1 + 22 × 10 given out.
  await expect(page.getByText("Remaining credits")).toBeVisible();
  await expect(page.locator("main").getByText("249 min", { exact: true }).first()).toBeVisible();

  const topup = page.getByRole("region", { name: "Credits added" }).locator("li").filter({ hasText: "Starting balance" });
  await expect(topup).toContainText("+500 min");
  await expect(topup).toContainText("TrainerTwin");

  await page.getByRole("tab", { name: "Details" }).click();
  const rows = page.getByRole("region", { name: "Learners" }).locator("ul li");
  await expect(rows).toHaveCount(20);
  await expect(page.getByText(`1–20 of ${more.length + 2}`)).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(rows).toHaveCount(more.length + 2 - 20);

  await page.getByLabel("Search learners").fill(learner.name);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("30");
});

test("Usage: an external balance sync updates the sidebar and Remaining credits without reloading", async ({ page }) => {
  const firstVersion = page.waitForResponse((response) => response.url().includes("minutes.version") && response.ok());
  await page.goto("/usage");
  await firstVersion;
  const remaining = page.locator("section").filter({ has: page.getByText("Remaining credits", { exact: true }) }).locator("p").nth(1);
  const sidebar = page.getByRole("link", { name: /^Usage/ });
  await expect(remaining).toHaveText(/[\d,]+ min/);
  const before = Number((await remaining.innerText()).replace(/[^\d]/g, ""));
  await expect(sidebar).toContainText(`${before} min`);
  const navigations: string[] = [];
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
  // Like seed.setup.ts, use Bun: the generated Prisma client cannot load in Playwright's Node/CJS process.
  const syncBalance = (delta: number) => execFileSync("bun", ["-e", `
    import "./e2e/use-test-db";
    import { db } from "./lib/db";
    const org = await db.organization.findUniqueOrThrow({ where: { slug: process.argv[1] } });
    await db.orgBilling.update({ where: { orgId: org.id }, data: { balanceMinutes: { increment: Number(process.argv[2]) } } });
    await db.$disconnect();
  `, seed().org.slug, String(delta)]);
  syncBalance(100);
  try {
    // The cache write a webhook-triggered sync makes; no action in this browser invalidates its queries.
    await expect(async () => {
      await expect(sidebar).toContainText(`${before + 100} min`, { timeout: 500 });
      await expect(remaining).toHaveText(`${before + 100} min`, { timeout: 500 });
    }).toPass({ timeout: 20_000 });
    expect(navigations).toEqual([]);
  } finally {
    syncBalance(-100);
  }
});
