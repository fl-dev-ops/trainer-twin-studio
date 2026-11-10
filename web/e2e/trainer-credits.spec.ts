import { expect, test, type Page } from "@playwright/test";
import { as, seed } from "./seed-data";

test.use(as("admin"));

async function remaining(page: Page) {
  await page.goto("/credits");
  const amount = page.locator("section").filter({ has: page.getByText("Remaining credits", { exact: true }) }).locator("p").nth(1);
  await expect(amount).toHaveText(/[\d,]+ min/);
  return Number((await amount.innerText()).replace(/[^\d]/g, ""));
}

async function assigned(page: Page, email: string, minutes: number) {
  await page.getByLabel("Search learners").fill(email);
  const row = page.locator("main li").filter({ hasText: email });
  await expect(row).toHaveCount(1);
  await expect(row).not.toContainText("Invite pending");
  await expect(row.locator(":scope > span").nth(1)).toHaveText(`${minutes} min`);
  await expect(row.locator(":scope > span").nth(3)).toHaveText(`${minutes} min`);
}

test("User credits: add 15, show attributed history, and prevent saving past 360", async ({ page }) => {
  const learner = seed().more[0];
  await page.goto(`/users/${learner.id}`);
  const summary = page.getByRole("region", { name: "Credits", exact: true });
  const amount = summary.locator("p").nth(1);
  await expect(amount).toHaveText(/[\d,]+ min/);
  const before = Number((await amount.innerText()).replace(/[^\d]/g, ""));
  await summary.getByRole("button", { name: "Add credits" }).click();
  const dialog = page.getByRole("dialog", { name: "Add credits", exact: true });
  await dialog.getByLabel("Credits to add").fill("15");
  await dialog.getByRole("button", { name: "Add 15 min", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(amount).toHaveText(`${before + 15} min`);
  await page.getByRole("tab", { name: "Credits", exact: true }).click();
  const history = page.getByRole("tabpanel").getByRole("listitem").filter({ hasText: "Added by trainer" });
  await expect(history).toContainText("+15 min");
  await expect(history).toContainText(seed().admin.name);

  await summary.getByRole("button", { name: "Add credits" }).click();
  await dialog.getByLabel("Credits to add").fill("361");
  await expect(dialog.getByRole("alert")).toContainText("360 min in total");
  await expect(dialog.getByRole("button", { name: "Add 361 min", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(amount).toHaveText(`${before + 15} min`);
});

test("Users bulk credits: preview total and org-after, add to two rows, and filter low balances", async ({ page }) => {
  const { more, broke } = seed();
  const people = more.slice(1, 3);
  const orgBefore = await remaining(page);
  await page.goto("/users");
  await expect(page.getByText("Credits left", { exact: true })).toBeVisible();
  const before: number[] = [];
  for (const person of people) {
    const row = page.locator("main li").filter({ has: page.getByRole("checkbox", { name: `Select ${person.name}`, exact: true }) });
    const credits = row.locator("div > span").last();
    await expect(credits).toContainText(/\d+ min/);
    before.push(Number((await credits.innerText()).match(/\d+/)![0]));
    await row.getByRole("checkbox").check();
  }
  await page.getByRole("button", { name: "Add credits", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add credits to 2 learners" });
  await dialog.getByLabel("Credits each").fill("10");
  await expect(dialog.getByText("20 min · 2 learners", { exact: true })).toBeVisible();
  await expect(dialog.locator("dl > div").filter({ hasText: "Org balance after" })).toContainText(`${orgBefore - 20} min`);
  await dialog.getByRole("button", { name: "Add 10 min each", exact: true }).click();
  await expect(page.getByText("10 min added for 2 learners", { exact: true })).toBeVisible();
  await expect(dialog).toBeHidden();
  for (const [i, person] of people.entries()) {
    const row = page.locator("main li").filter({ has: page.getByRole("checkbox", { name: `Select ${person.name}`, exact: true }) });
    await expect(row.locator("div > span").last()).toContainText(`${before[i] + 10} min`);
  }
  expect(await remaining(page)).toBe(orgBefore - 20);
  await page.goto("/users");
  await page.getByRole("button", { name: /Low on credits/ }).click();
  await expect(page.getByRole("button", { name: /Low on credits/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("link", { name: `Open ${broke.name}`, exact: true })).toBeVisible();
  for (const person of people) await expect(page.getByRole("link", { name: `Open ${person.name}`, exact: true })).toBeHidden();
});

test("Role-play assign: a new email gets 25 starting credits and appears immediately as a member", async ({ page }) => {
  const email = "e2e-roleplay-starting@example.com";
  const before = await remaining(page);
  await page.goto(`/roleplay/${seed().roleplay.slug}/assign`);
  await page.getByRole("button", { name: "Assign learners", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Assign roleplay", exact: true });
  await dialog.getByLabel("Add by email").fill(email);
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await dialog.locator("#assign-credits").fill("25");
  await dialog.getByRole("button", { name: "Assign", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(await remaining(page)).toBe(before - 25);
  await assigned(page, email, 25);
});

test("Settings add Users: chosen 40 starting credits appear on Credits", async ({ page }) => {
  const email = "e2e-settings-starting@example.com";
  const before = await remaining(page);
  await page.goto("/settings?tab=team");
  const users = page.locator('[data-slot="card"]').filter({ has: page.locator('[data-slot="card-title"]').filter({ hasText: /^Users/ }) });
  await users.getByRole("button", { name: "Add", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add users", exact: true });
  await dialog.getByLabel("Email addresses").fill(email);
  await dialog.locator("#invite-credits").fill("40");
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("1 person added", { exact: true })).toBeVisible();
  expect(await remaining(page)).toBe(before - 40);
  await assigned(page, email, 40);
});

test("Twin assign: a new email gets the chosen 15 starting credits", async ({ page }) => {
  const email = "e2e-twin-starting@example.com";
  const before = await remaining(page);
  await page.goto(`/twin/${seed().twin.slug}/assign`);
  await page.getByRole("button", { name: "Assign learners", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Assign twin agent", exact: true });
  await dialog.getByLabel("Add by email").fill(email);
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await dialog.locator("#assign-credits").fill("15");
  await dialog.getByRole("button", { name: "Assign", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(await remaining(page)).toBe(before - 15);
  await assigned(page, email, 15);
});
