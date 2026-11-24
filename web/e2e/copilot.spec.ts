import { expect, test } from "@playwright/test";
import { studio } from "../../copilot/agent/lib/studio";
import { E2E_SCENARIO_INGEST_SECRET, e2eUrl } from "./env";
import { as, seed } from "./seed-data";

function callStudio<T>(userId: string, action: Record<string, unknown>, secret = E2E_SCENARIO_INGEST_SECRET) {
  return studio<T>(
    { session: { auth: { current: { principalId: seed().org.id, principalType: "organization", attributes: { userId } } } } },
    action,
    fetch,
    { NODE_ENV: "test", STUDIO_URL: e2eUrl("dash"), SCENARIO_INGEST_SECRET: secret },
  );
}

test("Copilot reads published role plays over HTTP for its signed-in trainer", async () => {
  const { admin, learner, roleplay, twin } = seed();
  const action = { action: "list", kind: "roleplay" };
  const list = (userId: string, secret?: string) => callStudio<{ items: { slug: string }[] }>(userId, action, secret);

  const result = await list(admin.id);
  const slugs = result.items.map((item) => item.slug);
  expect(slugs).toContain(roleplay.slug);
  expect(slugs).not.toContain(twin.slug);
  await expect(list(learner.id)).rejects.toThrow("Only enabled studio members");
  await expect(list(admin.id, "incorrect-test-secret")).rejects.toThrow("Unauthorized");
});

test.describe("Copilot authors a Studio persona", () => {
  test.use(as("admin"));

  test("a persona saved through Copilot appears in Studio and survives reload", async ({ page }) => {
    const { admin } = seed();
    const name = "Copilot QA Buyer";
    const about = "Asks for delivery dates before discussing budget.";
    const created = await callStudio<{ ok: boolean; slug: string }>(admin.id, {
      action: "createPersona", name, role: "Buyer", about,
    });
    expect(created.ok).toBe(true);
    try {
      await page.goto(`/personas/${created.slug}`);
      await expect(page.getByText(about, { exact: true })).toBeVisible();
      await page.reload();
      await expect(page.getByText(about, { exact: true })).toBeVisible();
    } finally {
      await expect(await page.request.delete(`/api/spec/personas/${created.slug}`)).toBeOK();
    }
  });
});
