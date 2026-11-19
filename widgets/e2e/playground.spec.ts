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
  await expect(page.locator("#state-buttons button")).toHaveCount(3);
  await page.getByRole("button", { name: "Name", exact: true }).click();
  await expect(widget.getByRole("textbox", { name: "Your name" })).toBeVisible();
  await expect(widget.locator(".tt-portrait-stage")).toBeHidden();
  await page.getByRole("button", { name: "Call", exact: true }).click();
  await expect(widget.locator(".tt-card")).toHaveAttribute("data-agent-state", "speaking");
  await expect(widget.getByText("Powered by TrainerTwin", { exact: true })).toHaveCount(0);
  const mute = widget.getByRole("button", { name: "Mute microphone", exact: true });
  await expect(mute.locator("svg:first-child")).toBeVisible();
  await mute.click();
  const unmute = widget.getByRole("button", { name: "Unmute microphone" });
  await expect(unmute.locator("svg:last-child")).toBeVisible();
  await unmute.hover();
  await expect(unmute).toHaveCSS("background-color", "rgb(229, 225, 217)");
  await page.getByRole("button", { name: "Call", exact: true }).hover();
  await expect(unmute).toHaveCSS("background-color", "rgb(242, 238, 229)");
  await expect(widget.getByRole("log")).toContainText("giving feedback");
  await expect(widget.getByRole("button", { name: "Expand captions" })).toHaveCount(0);
  await expect(widget.getByText("What would you like to practice today?")).toHaveCount(0);
  revision = "second";
  await expect(iframe).toHaveAttribute("src", /state=call&revision=second/);
  await expect(widget.getByRole("button", { name: "End call" })).toBeVisible();
  expect(publicRequests).toEqual([]);
});

test("launcher preview runs the real loader and opens a simulated widget", async ({ page }) => {
  await page.goto("/playground");
  await page.getByRole("button", { name: "Button", exact: true }).click();
  await page.locator("#state-preview").scrollIntoViewIfNeeded();
  const preview = page.frameLocator("#state-preview");
  const hosted = preview.frameLocator(embedFrame);
  const launcher = hosted.getByRole("button", { name: "Talk to my AI twin" });
  await expect(hosted.getByRole("heading", { name: /Vasanth’s AI twin/ })).toBeVisible();
  await expect(hosted.locator(".tt-intro-portrait img")).toBeVisible();
  await expect(preview.locator('.floating[data-open="true"]')).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(preview.locator(".panel")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await launcher.click();
  const name = hosted.getByRole("textbox", { name: "Your name" });
  await expect(name).toBeFocused();
  await expect(hosted.locator(".tt-portrait-stage")).toBeHidden();
  await expect(hosted.getByText("What’s your name?", { exact: true })).toBeVisible();
  await expect(hosted.getByText("Press Enter to continue", { exact: true })).toBeHidden();
  await expect(hosted.getByRole("button", { name: "Continue", exact: true })).toHaveCount(0);
  await expect(name).toHaveCSS("border-bottom-width", "0px");
  const panel = await hosted.locator('.tt-card[data-stage="name"]').boundingBox();
  const hitArea = await hosted.locator(".tt-name-hit-area").boundingBox();
  expect(hitArea).toEqual(panel);
  await name.blur();
  await name.click({ position: { x: 24, y: 24 } });
  await expect(name).toBeFocused();
  await name.fill("Jordan");
  await expect(name).toHaveValue("Jordan");
  await expect(hosted.getByText("Press Enter to continue", { exact: true })).toBeVisible();
  await name.press("Enter");
  await expect(hosted.locator(".tt-portrait-stage")).toBeVisible();
  await hosted.getByRole("button", { name: "End call" }).click();
  await expect(launcher).toBeFocused();
  await launcher.click();
  await expect(hosted.getByRole("textbox", { name: "Your name" })).toBeHidden();
  await expect(hosted.getByRole("button", { name: "Mute microphone" })).toBeEnabled();
  await hosted.getByRole("button", { name: "End call" }).click();
  await hosted.getByRole("button", { name: "Change your name" }).click();
  await expect(hosted.getByRole("textbox", { name: "Your name" })).toHaveValue("Jordan");
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
  await page.getByRole("button", { name: "Talk to AI twin", exact: true }).click();
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
