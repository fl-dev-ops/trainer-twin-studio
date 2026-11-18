import { expect, test } from "../../web/node_modules/@playwright/test";

test("paste a snippet, mount inline, remove and reload as floating", async ({ page }) => {
  await page.goto("/playground");
  await expect(page.locator("#origin")).toHaveText("http://127.0.0.1:43181");
  await page.getByLabel("Embed snippet or hosted-widget URL").fill(
    '<script src="http://127.0.0.1:43182/widgets/v1.js" data-twin-id="demo" data-mode="inline" onload="window.injected=true"></script><img src=x onerror="window.injected=true">',
  );
  await page.getByRole("button", { name: "Load widget", exact: true }).click();
  const frame = page.frameLocator('iframe[title="Talk to AI twin"]');
  await expect(frame.locator("#state")).toHaveText("Ready");
  await expect(page.locator("#preview iframe")).toBeVisible();
  expect(await page.evaluate(() => "injected" in window)).toBe(false);
  await page.getByRole("button", { name: "Remove widget" }).click();
  await expect(page.locator("iframe")).toHaveCount(0);
  await page.getByLabel("Display", { exact: true }).selectOption("floating");
  await page.getByRole("button", { name: "Load widget", exact: true }).click();
  await expect(page.getByRole("button", { name: "Talk to AI twin", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Talk to AI twin", exact: true }).click();
  await expect(frame.locator("#state")).toHaveText("Ready");
});

test("hosted URL supports an explicit local server override", async ({ page }) => {
  await page.goto("/playground");
  await page.getByLabel("Embed snippet or hosted-widget URL").fill("https://example.com/embed/demo?mode=inline");
  await page.getByLabel("Widget server override (optional)").fill("http://127.0.0.1:43182");
  await page.getByRole("button", { name: "Load widget", exact: true }).click();
  await expect(page.frameLocator("iframe").locator("#state")).toHaveText("Ready");
  await expect(page.locator("iframe")).toHaveAttribute("src", /127\.0\.0\.1:43182\/embed\/demo/);
});

test("invalid input cannot execute script or replace an existing widget", async ({ page }) => {
  await page.goto("/playground");
  const input = page.getByLabel("Embed snippet or hosted-widget URL");
  await input.fill("http://127.0.0.1:43182/embed/demo?mode=inline");
  await page.getByRole("button", { name: "Load widget", exact: true }).click();
  await expect(page.frameLocator("iframe").locator("#state")).toHaveText("Ready");
  for (const value of [
    '<script>window.injected=true</script>',
    "javascript:alert(1)",
    "https://user:password@example.com/embed/demo",
    '<script src="https://example.com/other.js" data-twin-id="demo"></script>',
    "https://example.com/embed/",
  ]) {
    await input.fill(value);
    await page.getByRole("button", { name: "Load widget", exact: true }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.frameLocator("iframe").locator("#state")).toHaveText("Ready");
  }
  expect(await page.evaluate(() => "injected" in window)).toBe(false);
});

test("a failed loader can be corrected and retried", async ({ page }) => {
  await page.goto("/playground");
  await page.route("http://127.0.0.1:43182/widgets/v1.js", (route) => route.abort());
  await page.getByLabel("Embed snippet or hosted-widget URL").fill("http://127.0.0.1:43182/embed/demo?mode=inline");
  await page.getByRole("button", { name: "Load widget", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Could not load the widget script");
  await expect(page.getByRole("button", { name: "Load widget", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Remove widget" })).toBeDisabled();
  await page.unroute("http://127.0.0.1:43182/widgets/v1.js");
  await page.getByRole("button", { name: "Load widget", exact: true }).click();
  await expect(page.frameLocator("iframe").locator("#state")).toHaveText("Ready");
  await expect(page.getByRole("alert")).toBeHidden();
});
