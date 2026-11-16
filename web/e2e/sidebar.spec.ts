import { expect, test } from "@playwright/test";
import { as } from "./seed-data";

test.use({ ...as("admin"), viewport: { width: 390, height: 844 } });

test("sidebar gives 16px text comfortable rows and lighter icons", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/twin");
  const panel = page.locator('[data-slot="sidebar-container"][data-side="left"]');
  await expect(panel).toHaveCSS("width", "288px");
  const item = panel.getByRole("link", { name: "Twin agents", exact: true });
  await expect(item).toHaveCSS("font-size", "16px");
  await expect(item).toHaveCSS("height", "36px");
  await expect(item).toHaveCSS("max-height", "36px");
  await expect(item).toHaveCSS("border-radius", "6px");
  await expect(item).toHaveCSS("padding-left", "8px");
  await expect(item).toHaveCSS("padding-right", "8px");
  await expect(item.locator("svg")).toHaveCSS("height", "18px");
  await expect(item.locator("svg")).toHaveCSS("stroke-width", "1.5px");
  await expect(panel.locator('[data-slot="sidebar-menu"]').first()).toHaveCSS("row-gap", "4px");
});

test("collapsed navigation still scrolls on short desktop screens", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 520 });
  await page.goto("/twin");
  await page.getByRole("button", { name: "Toggle menu", exact: true }).click();

  const content = page.locator('[data-side="left"] [data-slot="sidebar-content"]');
  await expect(content).toHaveCSS("overflow-y", "auto");
  await content.hover();
  await page.mouse.wheel(0, 500);
  await expect.poll(() => content.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await expect(page.getByRole("link", { name: "Personas", exact: true })).toBeInViewport();
});

test("mobile sidebar uses its own width and the brand toggle closes the drawer", async ({ page }) => {
  await page.goto("/twin");
  const opener = page.getByRole("button", { name: "Toggle left sidebar", exact: true });
  await opener.click();

  const drawer = page.locator('[data-slot="sidebar"][data-mobile="true"]');
  await expect(drawer).toBeVisible();
  await expect(drawer).toHaveCSS("width", "288px");
  const toggle = drawer.getByRole("button", { name: "Toggle menu", exact: true });
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(drawer.getByRole("link", { name: "Twin agents", exact: true })).toBeVisible();

  await toggle.click();
  await expect(drawer).toBeHidden();
  await expect(opener).toHaveAttribute("aria-expanded", "false");
});
