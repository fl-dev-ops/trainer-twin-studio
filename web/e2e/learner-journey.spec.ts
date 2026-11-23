import { devices, expect, test } from "@playwright/test";
import { RoomServiceClient } from "livekit-server-sdk";
import { e2eUrl, localLiveKit, localVoice } from "./env";
import { as, seed } from "./seed-data";

const mobile = { ...devices["Pixel 7"], ...as("recipient") };

test("a trainer assigns practice and only the intended learner can open it on mobile", async ({ browser }) => {
  const { org, roleplay, recipient, broke } = seed();
  const studio = await browser.newPage({ ...as("admin"), baseURL: e2eUrl("dash") });
  const learner = await browser.newPage(mobile);
  const wrongAccount = await browser.newPage({ ...mobile, ...as("broke") });
  try {
    await learner.goto(e2eUrl(org.slug));
    await expect(learner.getByRole("heading", { name: "Nothing assigned to you yet" })).toBeVisible();
    await expect(learner.getByRole("button", { name: "Start role play" })).toHaveCount(0);

    await studio.goto("/roleplay");
    await studio.getByRole("button", { name: "Actions for Pitch practice" }).first().click();
    await studio.getByRole("menuitem", { name: "Assign", exact: true }).click();
    await expect(studio).toHaveURL(new RegExp(`/roleplay/${roleplay.slug}/assign$`));
    const open = studio.getByRole("button", { name: "Assign learners" });
    await open.click();
    const dialog = studio.getByRole("dialog", { name: "Assign roleplay" });
    const search = dialog.getByRole("searchbox", { name: "Search learners" });
    const assign = dialog.getByRole("button", { name: "Assign", exact: true });
    await expect(assign).toBeDisabled();
    await search.fill("no matching learner");
    await expect(dialog.getByText("No one matches that search.")).toBeVisible();
    await search.fill(recipient.email);
    await dialog.getByRole("checkbox", { name: `Assign ${recipient.name}` }).check();
    await assign.click();
    await expect(dialog).toBeHidden();
    await expect(studio.getByRole("listitem").filter({ hasText: recipient.email })).toContainText("Assigned");
    await studio.reload();
    await expect(studio.getByRole("listitem").filter({ hasText: recipient.email })).toContainText("Assigned");

    await learner.reload();
    await expect(learner.getByRole("heading", { name: "Pitch practice" })).toBeVisible();
    await learner.getByRole("button", { name: "Start role play" }).tap();
    await expect(learner.getByText("10 min of practice left · the call ends when they run out")).toBeVisible();
    await expect(learner.getByRole("button", { name: "Join session", exact: true })).toBeInViewport();
    expect(await learner.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(mobile.viewport.width);

    await wrongAccount.goto(learner.url());
    await expect(wrongAccount.getByText("Use the account you were added with")).toBeVisible();
    await expect(wrongAccount.getByText(`You are signed in as ${broke.email}`, { exact: false })).toBeVisible();
    await expect(wrongAccount.getByRole("button", { name: "Switch account" })).toBeVisible();
    await expect(wrongAccount.getByRole("button", { name: "Join session", exact: true })).toHaveCount(0);
  } finally {
    await Promise.all([studio.close(), learner.close(), wrongAccount.close()]);
  }
});

test("a learner with blocked devices can continue and retry after getting back online", async ({ browser }) => {
  const { org, codes, learner } = seed();
  const page = await browser.newPage({ ...mobile, ...as("learner") });
  try {
    const cdp = await page.context().newCDPSession(page);
    for (const name of ["microphone", "camera"]) {
      await cdp.send("Browser.setPermission", { permission: { name }, setting: "denied", origin: new URL(e2eUrl(org.slug)).origin });
    }
    await page.goto(e2eUrl(org.slug, `/s/${codes.learner}`));
    await expect(page.getByRole("button", { name: "Try device check again" })).toBeVisible();
    const join = page.getByRole("button", { name: "Join session", exact: true });
    await expect(join).toBeEnabled();
    await page.context().setOffline(true);
    await join.tap();
    await expect(page.getByRole("alert").filter({ hasText: "Check your connection and try again." })).toBeVisible();
    await expect(page.getByLabel("Session time")).toHaveText("00:00");
    const retry = page.getByRole("button", { name: "Try again", exact: true });
    await expect(retry).toBeInViewport();
    await page.context().setOffline(false);
    const start = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/sessions" && response.request().method() === "POST");
    await retry.tap();
    const response = await start;
    if (!localVoice) {
      expect(response.status()).toBe(400);
      await expect(page.getByText(/Ask your trainer to check the voice settings/)).toBeVisible();
      return;
    }

    expect(response.ok(), await response.text()).toBe(true);
    const { room } = await response.json() as { room: string };
    const rooms = new RoomServiceClient(localLiveKit.url, localLiveKit.key, localLiveKit.secret);
    await expect.poll(async () => (await rooms.listParticipants(room)).map((p) => p.identity)).toContain(`user-${learner.id}`);
    await expect(page.getByRole("button", { name: "Unmute microphone" })).toBeVisible();
    const end = page.getByRole("button", { name: "End session", exact: true });
    await end.tap();
    await page.getByRole("button", { name: /No, I.ll continue/ }).tap();
    await expect(end).toBeVisible();
    await page.route("**/api/sessions/finalize", (route) => route.fulfill({ status: 503 }), { times: 1 });
    await end.tap();
    await page.getByRole("button", { name: "Yes, end session" }).tap();
    await expect(page.getByText("Could not save session")).toBeVisible();
    await retry.tap();
    await expect(page.getByText("Your responses have been saved.", { exact: false })).toBeVisible();
    const feedback = page.getByRole("button", { name: "Send feedback" });
    await expect(feedback).toBeDisabled();
    await page.getByRole("button", { name: "5", exact: true }).tap();
    await feedback.tap();
    await expect(page.getByText("Thanks for your feedback")).toBeVisible();
    await page.getByRole("button", { name: "Practise again", exact: true }).tap();
    await expect(join).toBeEnabled();
  } finally {
    await page.close();
  }
});
