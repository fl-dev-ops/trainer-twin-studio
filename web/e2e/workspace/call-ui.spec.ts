import { expect, test } from "@playwright/test";

for (const width of [1440, 390]) for (const theme of ["dark", "light"]) for (const workspace of ["", "canvas"]) {
  test(`call UI ${width}px ${theme} ${workspace || "conversation"}: visible controls and bounded layout`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto(`/call-ui?theme=${theme}&workspace=${workspace}`);
    await expect(page.getByRole("heading", { name: "Resume Defense & Cross-Examination" })).toBeVisible();
    await expect(page.getByRole("button", { name: "End session", exact: true })).toBeVisible();
    if (workspace) {
      await expect(page.locator(".excalidraw")).toBeVisible();
      const bounds = await page.getByRole("region", { name: "Session workspace" }).boundingBox();
      expect(bounds?.height).toBeGreaterThan(250);
      expect(bounds?.width).toBeGreaterThan(width === 390 ? 300 : 700);
    } else await expect(page.getByText("What was the most important trade-off you made, and why?", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const controls = await page.getByRole("toolbar", { name: "Session controls" }).boundingBox();
    expect(controls!.x).toBeGreaterThanOrEqual(0);
    expect(controls!.x + controls!.width).toBeLessThanOrEqual(width + 1);
    const camera = await page.getByRole("button", { name: "Turn on camera", exact: true }).boundingBox();
    const end = await page.getByRole("button", { name: "End session", exact: true }).boundingBox();
    expect(Math.abs(camera!.y - end!.y)).toBeLessThan(2);
    expect(camera!.width).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: info.outputPath("screen.png") });
  });
}

test("shared composer sends once and End still asks for confirmation", async ({ page }) => {
  await page.goto("/call-ui");
  await page.getByRole("button", { name: "Type a message", exact: true }).click();
  await page.getByRole("textbox", { name: "Message Vasanth" }).fill("Please repeat the question.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByText("Please repeat the question.", { exact: true })).toHaveCount(1);
  await expect(page.getByRole("textbox", { name: "Message Vasanth" })).toHaveValue("");
  await page.getByRole("button", { name: "End session", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("button", { name: "No, I’ll continue" }).click();
  await expect(page.getByText("Session ended", { exact: true })).toHaveCount(0);
});

test("mobile workspace keeps its canvas visible and opens transcript in a sheet only on request", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/call-ui?workspace=canvas");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Transcript", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog").getByText("Sketch the architecture on the whiteboard. Show how the components communicate.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close transcript", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Session workspace" })).toBeVisible();
});
