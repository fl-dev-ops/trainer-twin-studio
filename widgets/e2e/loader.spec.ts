import { expect, test, type Page } from "../../web/node_modules/@playwright/test";

const widgetOrigin = "http://127.0.0.1:43182";
const launcher = (page: Page) => page.locator("[data-trainertwin-widget] button");
const frame = (page: Page) => page.frameLocator('iframe[title="Talk to AI twin"]');
async function open(page: Page) {
  await launcher(page).focus();
  await launcher(page).press("Enter");
  await expect(page.locator("iframe")).toBeVisible();
}
async function hoverOpen(page: Page) {
  await expect(launcher(page)).toBeVisible();
  const box = await launcher(page).boundingBox();
  if (!box) throw new Error("Expected launcher bounds");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

test("floating handshake, microphone delegation, active minimise/reopen and focus return", async ({ page }) => {
  await page.goto("/");
  await expect(launcher(page)).toBeVisible();
  await expect(page.locator("iframe")).toHaveAttribute("allow", `microphone ${widgetOrigin}`);
  await expect(page.locator("iframe")).toHaveAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
  await expect(page.locator("iframe")).toHaveAttribute("referrerpolicy", "no-referrer");
  await expect(page.locator("iframe")).toBeHidden();
  const closedLauncher = await launcher(page).boundingBox();
  await open(page);
  await expect.poll(async () => {
    const panel = await page.locator("iframe").boundingBox();
    return Math.round((panel!.x + panel!.width) - (closedLauncher!.x + closedLauncher!.width));
  }).toBe(0);
  await expect(frame(page).locator("#state")).toHaveText("Ready");
  await frame(page).getByRole("button", { name: "Start fixture call" }).click();
  await expect(page.getByRole("status")).toHaveText("AI twin call in progress");
  await expect(launcher(page)).toHaveText("Call in progress");
  const originalFrame = page.frames().find((item) => item.url().startsWith(`${widgetOrigin}/embed/`));
  expect(originalFrame).toBeDefined();
  await frame(page).getByRole("button", { name: "Minimise" }).click();
  await expect(page.locator("iframe")).toBeHidden();
  await expect(launcher(page)).toBeFocused();
  await open(page);
  expect(await originalFrame?.evaluate("window.active")).toBe(true);
  expect(await originalFrame?.evaluate("window.received")).toEqual(expect.arrayContaining([
    { source: "trainertwin-host", version: 1, type: "init" },
    { source: "trainertwin-host", version: 1, type: "visibility", open: true },
    { source: "trainertwin-host", version: 1, type: "visibility", open: false },
  ]));
  await page.keyboard.press("Escape");
  await expect(page.locator("iframe")).toBeHidden();
  await expect(launcher(page)).toBeFocused();
});

test("floating mounts remain independent and inline mode is rejected", async ({ page }) => {
  await page.goto("/");
  await expect(launcher(page)).toBeVisible();
  await page.evaluate(() => {
    const script = document.createElement("script");
    script.id = "second";
    script.src = "http://127.0.0.1:43182/widgets/v1.js";
    script.dataset.twinId = "second";
    document.body.append(script);
    window.TrainerTwinWidgets!.mount({ script });
  });
  await expect(page.locator("[data-trainertwin-widget]")).toHaveCount(2);
  await page.evaluate(() => window.TrainerTwinWidgets!.destroy(document.querySelector<HTMLScriptElement>("#second")!));
  await expect(page.locator("[data-trainertwin-widget]")).toHaveCount(1);
});

test("hover expands one surface, crosses into the iframe, and shrinks only after leaving", async ({ page }) => {
  await page.goto("/");
  await hoverOpen(page);
  expect(await page.locator("[data-trainertwin-widget] .floating").evaluate((node) =>
    Number.parseFloat(getComputedStyle(node).borderTopLeftRadius))).toBeLessThanOrEqual(28);
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(launcher(page)).toBeHidden();
  await frame(page).getByRole("button", { name: "Start fixture call" }).hover();
  await expect(page.getByRole("dialog")).toBeVisible();
  await frame(page).getByRole("button", { name: "Start fixture call" }).click();
  const child = page.frames().find((item) => item.url().startsWith(`${widgetOrigin}/embed/`));
  if (!child) throw new Error("Expected hosted frame");
  await page.getByRole("heading", { name: "Customer website" }).hover();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(launcher(page)).toBeVisible();
  expect(await child.evaluate("window.active")).toBe(true);
  await hoverOpen(page);
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(await child.evaluate("window.active")).toBe(true);
});

test("touch uses tap rather than hover", async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto("http://127.0.0.1:43181/");
  await launcher(page).tap();
  await expect(page.getByRole("dialog")).toBeVisible();
  await frame(page).getByRole("button", { name: "Minimise" }).tap();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(launcher(page)).toBeVisible();
  await context.close();
});

test("duplicate execution per script is idempotent and destroy permits clean remount", async ({ page }) => {
  await page.goto("/");
  await expect(launcher(page)).toBeVisible();
  await page.evaluate(() => {
    const script = document.querySelector<HTMLScriptElement>("#install")!;
    const first = window.TrainerTwinWidgets!.mount({ script });
    if (first !== window.TrainerTwinWidgets!.mount({ script })) throw new Error("Not idempotent");
  });
  await expect(page.locator("[data-trainertwin-widget]")).toHaveCount(1);
  await page.evaluate(() => {
    const script = document.querySelector<HTMLScriptElement>("#install")!;
    window.TrainerTwinWidgets!.destroy(script);
    window.TrainerTwinWidgets!.destroy(script);
  });
  await expect(page.locator("[data-trainertwin-widget]")).toHaveCount(0);
  await page.evaluate(() => {
    window.TrainerTwinWidgets!.mount({ script: document.querySelector<HTMLScriptElement>("#install")! });
  });
  await expect(launcher(page)).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(1);
});

test("ignores wrong source, wrong origin, version and arbitrary sizing messages", async ({ page }) => {
  await page.goto("/");
  await open(page);
  await expect(frame(page).locator("#state")).toHaveText("Ready");
  await page.evaluate(() => {
    window.postMessage({ source: "trainertwin-widget", version: 1, type: "close" }, window.location.origin);
  });
  const original = page.locator('iframe[title="Talk to AI twin"]');
  const child = page.frames().find((item) => item.url().startsWith(`${widgetOrigin}/embed/demo`));
  if (!child) throw new Error("Expected the hosted frame");
  await child.evaluate(() => {
    const origin = new URL(location.href).searchParams.get("parentOrigin")!;
    parent.postMessage({ source: "trainertwin-widget", version: 2, type: "close" }, origin);
    parent.postMessage({ source: "trainertwin-widget", version: 1, type: "resize", height: 100000 }, origin);
  });
  await page.evaluate((origin) => {
    const spoof = document.createElement("iframe");
    spoof.id = "spoof";
    spoof.src = `${origin}/embed/spoof?parentOrigin=${encodeURIComponent(location.origin)}`;
    document.body.append(spoof);
  }, widgetOrigin);
  const spoof = page.frameLocator("#spoof");
  await expect(spoof.locator("#state")).toHaveText("Waiting");
  await page.locator("#spoof").evaluate(async (node) => {
    if (!(node instanceof HTMLIFrameElement)) throw new Error("Expected spoof frame");
    node.contentWindow?.postMessage({ source: "trainertwin-host", version: 1, type: "init" }, new URL(node.src).origin);
  });
  await expect(spoof.locator("#state")).toHaveText("Ready");
  await spoof.locator("#close").evaluate((node) => {
    if (node instanceof HTMLButtonElement) node.click();
  });
  await expect(original).toBeVisible();
  await page.evaluate(() => {
    window.addEventListener("message", (event) => {
      if (event.origin === location.origin && event.data?.marker === "origin-check") document.body.dataset.originCheck = "received";
    });
  });
  await child.goto("http://127.0.0.1:43181/attacker");
  await expect(page.locator("body")).toHaveAttribute("data-origin-check", "received");
  await expect(original).toBeVisible();
  await expect(launcher(page)).toHaveAttribute("aria-expanded", "true");
});

test("mobile panel stays within viewport and parent Escape returns focus", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/");
  await open(page);
  const box = await page.locator("iframe").boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(320);
  expect(box!.y + box!.height).toBeLessThanOrEqual(568);
  await frame(page).locator("body").press("Escape");
  await expect(launcher(page)).toBeFocused();
  await expect(page.locator("iframe")).toBeHidden();
});

test("invalid modes, targets and script protocols fail without creating a mount", async ({ page }) => {
  await page.goto("/");
  await expect(launcher(page)).toBeVisible();
  const errors = await page.evaluate(() => {
    return [
      { src: "javascript:alert(1)", mode: "floating" },
      { src: "https://org.example/widgets/v1.js", mode: "popup" },
      { src: "https://org.example/widgets/v1.js", mode: "inline", target: "#bad selector" },
      { src: "https://org.example/widgets/v1.js", mode: "inline", target: "missing" },
      { src: "https://org.example/widgets/v1.js", mode: "inline" },
    ].map((options) => {
      const script = document.createElement("script");
      script.src = options.src;
      script.dataset.twinId = "demo";
      script.dataset.mode = options.mode;
      if (options.target) script.dataset.target = options.target;
      try {
        window.TrainerTwinWidgets!.mount({ script });
        return false;
      } catch {
        return true;
      }
    });
  });
  expect(errors).toEqual([true, true, true, true, true]);
  await expect(page.locator("[data-trainertwin-widget]")).toHaveCount(1);
});
