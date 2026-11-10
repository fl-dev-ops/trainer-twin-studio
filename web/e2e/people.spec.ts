import { expect, test } from "@playwright/test";
import { as, seed } from "./seed-data";

test.use(as("admin"));

test("Settings adds a learner, assigns a twin, and all three people lists show the same identity and credits", async ({ page }) => {
  const email = `e2e-lists-${Date.now()}@example.com`;
  const name = email.split("@")[0];
  await page.goto("/settings?tab=team");
  const users = page.locator('[data-slot="card"]').filter({ has: page.locator('[data-slot="card-title"]').filter({ hasText: /^Users/ }) });
  await users.getByRole("button", { name: "Add", exact: true }).click();
  const add = page.getByRole("dialog", { name: "Add users", exact: true });
  await add.getByLabel("Email addresses").fill(email);
  await add.locator("#invite-credits").fill("30");
  await add.getByRole("button", { name: "Add", exact: true }).click();
  await expect(add).toBeHidden();
  await users.getByRole("searchbox", { name: "Search users" }).fill(email);
  const settingsRow = users.getByRole("listitem").filter({ hasText: email });
  await expect(settingsRow).toHaveCount(1);
  await expect(settingsRow).toContainText(name);
  await expect(settingsRow).not.toContainText(/Invite|pending|waiting/i);
  const href = await settingsRow.getByRole("link", { name, exact: true }).getAttribute("href");
  expect(href).toMatch(/^\/users\/.+/);

  await page.goto(`/twin/${seed().twin.slug}/assign`);
  await page.getByRole("button", { name: "Assign learners", exact: true }).click();
  const assign = page.getByRole("dialog", { name: "Assign twin agent", exact: true });
  await assign.getByRole("searchbox", { name: "Search learners" }).fill(email);
  await assign.getByRole("checkbox", { name: `Assign ${name}`, exact: true }).check();
  await assign.getByRole("button", { name: "Assign", exact: true }).click();
  await expect(assign).toBeHidden();

  await page.goto("/users");
  await page.getByRole("searchbox").fill(email);
  const row = page.locator("main li").filter({ has: page.getByRole("link", { name: `Open ${name}`, exact: true }) });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(name);
  await expect(row).toContainText("30 min");
  await expect(row.getByRole("link", { name: `Open ${name}`, exact: true })).toHaveAttribute("href", href!);
  await expect(row).not.toContainText(/Invite|pending|waiting/i);

  await page.goto("/twin/users");
  const twinRow = page.locator("main div.grid").filter({ has: page.getByText(email, { exact: true }) }).filter({ has: page.getByText(name, { exact: true }) });
  await expect(twinRow).toHaveCount(1);
  await expect(twinRow).toContainText(name);
  await expect(twinRow).toContainText(email);
  await expect(twinRow).toContainText("30 min");
  await expect(twinRow).toContainText("0 used · 30 left");
  await expect(twinRow).not.toContainText(/Invite|pending|waiting/i);

  await page.goto("/settings?tab=team");
  await users.getByRole("searchbox", { name: "Search users" }).fill(email);
  await expect(settingsRow).toHaveCount(1);
  await expect(settingsRow.getByRole("link", { name, exact: true })).toHaveAttribute("href", href!);
});
