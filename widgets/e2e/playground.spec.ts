import { expect, test } from "../../web/node_modules/@playwright/test";

const embedFrame = 'iframe[title="Talk to AI twin"]';

test("design preview renders widget states and refreshes the selected state without a live call", async ({ page }) => {
  let revision = "first";
  await page.route("**/preview/version", (route) => route.fulfill({ json: revision }));
  const publicRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/public/")) publicRequests.push(request.url());
  });
  await page.goto("/playground");
  const iframe = page.locator("#state-preview");
  const widget = iframe.contentFrame();
  await expect(widget.getByRole("heading", { name: "Talk to my AI twin" })).toBeVisible();
  await page.getByRole("button", { name: "Connecting", exact: true }).click();
  await expect(widget.getByRole("status")).toHaveText("Connecting…");
  await page.getByRole("button", { name: "Speaking", exact: true }).click();
  await expect(widget.locator(".tt-card")).toHaveAttribute("data-agent-state", "speaking");
  await expect(widget.getByText("Powered by TrainerTwin", { exact: true })).toHaveCount(0);
  const mute = widget.getByRole("button", { name: "Mute microphone", exact: true });
  await expect(mute.locator("svg:first-child")).toBeVisible();
  await mute.click();
  await expect(widget.getByRole("button", { name: "Unmute microphone" }).locator("svg:last-child")).toBeVisible();
  await expect(widget.getByRole("log")).toContainText("giving feedback");
  await widget.getByRole("button", { name: "Expand captions" }).click();
  await expect(widget.getByText("What would you like to practice today?")).toBeVisible();
  revision = "second";
  await expect(iframe).toHaveAttribute("src", /state=speaking&revision=second/);
  await widget.getByRole("button", { name: "End call" }).click();
  await expect(widget.getByRole("heading", { name: "Thanks for the conversation." })).toBeVisible();
  await expect(widget.getByRole("alert")).toBeHidden();
  await widget.getByRole("button", { name: "Start a new call" }).click();
  await widget.getByRole("textbox", { name: "Your name" }).fill("Jordan");
  await widget.getByRole("button", { name: "Start voice call" }).click();
  await expect(widget.getByRole("button", { name: "Mute microphone" })).toBeEnabled();
  await page.getByRole("button", { name: "Couldn’t connect" }).click();
  await expect(widget.getByRole("heading", { name: "We couldn’t start the conversation." })).toBeVisible();
  expect(publicRequests).toEqual([]);
});

test("launcher preview runs the real loader and opens a simulated widget", async ({ page }) => {
  await page.goto("/playground");
  await page.getByRole("button", { name: "Launcher", exact: true }).click();
  const preview = page.frameLocator("#state-preview");
  const launcher = preview.getByRole("button", { name: "Talk to AI twin" });
  await expect(launcher).toBeVisible();
  await expect(launcher).toHaveAttribute("aria-expanded", "false");
  await launcher.focus();
  await launcher.press("Enter");
  const hosted = preview.frameLocator(embedFrame);
  await expect(hosted.getByRole("button", { name: "Start voice call" })).toBeEnabled();
  await page.getByRole("button", { name: "Returning visitor", exact: true }).click();
  await expect(preview.getByText("Jordan", { exact: true })).toBeVisible();
  await expect(preview.getByRole("textbox", { name: "Your name" })).toBeHidden();
  await preview.getByRole("button", { name: "Change your name" }).click();
  await expect(preview.getByRole("textbox", { name: "Your name" })).toHaveValue("Jordan");
});

test("paste a floating snippet, remove and reload without executing pasted HTML", async ({ page }) => {
  await page.goto("/playground");
  await expect(page.locator("#origin")).toHaveText("http://127.0.0.1:43181");
  await page.getByLabel("Embed snippet or hosted-widget URL").fill(
    '<script src="http://127.0.0.1:43182/widgets/v1.js" data-twin-id="demo" data-mode="floating" onload="window.injected=true"></script><img src=x onerror="window.injected=true">',
  );
  await page.getByRole("button", { name: "Load widget", exact: true }).click();
  const frame = page.frameLocator(embedFrame);
  await expect(frame.locator("#state")).toHaveText("Ready");
  await expect(page.locator(embedFrame)).toBeHidden();
  expect(await page.evaluate(() => "injected" in window)).toBe(false);
  await page.getByRole("button", { name: "Remove widget" }).click();
  await expect(page.locator(embedFrame)).toHaveCount(0);
  await page.getByRole("button", { name: "Load widget", exact: true }).click();
  await expect(page.getByRole("button", { name: "Talk to AI twin", exact: true })).toBeVisible();
  const launcher = await page.getByRole("button", { name: "Talk to AI twin", exact: true }).boundingBox();
  if (!launcher) throw new Error("Expected floating launcher");
  await page.mouse.move(launcher.x + launcher.width / 2, launcher.y + launcher.height / 2);
  await expect(frame.locator("#state")).toHaveText("Ready");
});

test("hosted URL supports an explicit local server override", async ({ page }) => {
  await page.goto("/playground");
  await page.getByLabel("Embed snippet or hosted-widget URL").fill("https://example.com/embed/demo");
  await page.getByLabel("Widget server override (optional)").fill("http://127.0.0.1:43182");
  await page.getByRole("button", { name: "Load widget", exact: true }).click();
  await expect(page.frameLocator(embedFrame).locator("#state")).toHaveText("Ready");
  await expect(page.locator(embedFrame)).toHaveAttribute("src", /127\.0\.0\.1:43182\/embed\/demo/);
});

test("invalid input cannot execute script or replace an existing widget", async ({ page }) => {
  await page.goto("/playground");
  const input = page.getByLabel("Embed snippet or hosted-widget URL");
  await input.fill("http://127.0.0.1:43182/embed/demo");
  await page.getByRole("button", { name: "Load widget", exact: true }).click();
  await expect(page.frameLocator(embedFrame).locator("#state")).toHaveText("Ready");
  for (const value of [
    '<script>window.injected=true</script>',
    "javascript:alert(1)",
    "https://user:password@example.com/embed/demo",
    '<script src="https://example.com/other.js" data-twin-id="demo"></script>',
    "https://example.com/embed/",
    "http://127.0.0.1:43182/embed/demo?mode=inline",
  ]) {
    await input.fill(value);
    await page.getByRole("button", { name: "Load widget", exact: true }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.frameLocator(embedFrame).locator("#state")).toHaveText("Ready");
  }
  expect(await page.evaluate(() => "injected" in window)).toBe(false);
});

test("a failed loader can be corrected and retried", async ({ page }) => {
  await page.goto("/playground");
  await page.route("http://127.0.0.1:43182/widgets/v1.js", (route) => route.abort());
  await page.getByLabel("Embed snippet or hosted-widget URL").fill("http://127.0.0.1:43182/embed/demo");
  await page.getByRole("button", { name: "Load widget", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Could not load the widget script");
  await expect(page.getByRole("button", { name: "Load widget", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Remove widget" })).toBeDisabled();
  await page.unroute("http://127.0.0.1:43182/widgets/v1.js");
  await page.getByRole("button", { name: "Load widget", exact: true }).click();
  await expect(page.frameLocator(embedFrame).locator("#state")).toHaveText("Ready");
  await expect(page.getByRole("alert")).toBeHidden();
});
