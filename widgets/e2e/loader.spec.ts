import { expect, test, type Page } from "../../web/node_modules/@playwright/test";

const widgetOrigin = "http://127.0.0.1:43182";
const card = (page: Page) => page.locator("[data-trainertwin-widget] .floating");
const frame = (page: Page) => page.frameLocator('iframe[title="Talk to AI twin"]');
const hostedFrame = (page: Page) => {
  const child = page.frames().find((item) => item.url().startsWith(`${widgetOrigin}/embed/demo`));
  if (!child) throw new Error("Expected the hosted frame");
  return child;
};
const received = (page: Page) => hostedFrame(page).evaluate(() => (window as unknown as { received: unknown[] }).received);
const reset = { source: "trainertwin-host", version: 1, type: "reset" };

async function shown(page: Page) {
  await expect(page.locator("iframe")).toBeVisible();
  await expect(card(page)).toHaveAttribute("data-shown", "true");
  await expect(card(page)).toHaveCSS("transform", "none");
  await expect(card(page)).toHaveCSS("opacity", "1");
  await expect(frame(page).locator("#state")).toHaveText("Ready");
}

test("intro card is the resting state: no launcher button, shown once measured", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("[data-trainertwin-widget] button")).toHaveCount(0);
  await expect(page.locator("iframe")).toHaveAttribute("allow", `microphone ${widgetOrigin}`);
  await expect(page.locator("iframe")).toHaveAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
  await expect(page.locator("iframe")).toHaveAttribute("referrerpolicy", "no-referrer");
  await shown(page);
  await expect.poll(async () => (await page.locator("iframe").boundingBox())?.height).toBe(400);
  expect(await received(page)).toEqual(expect.arrayContaining([
    { source: "trainertwin-host", version: 1, type: "init" },
    { source: "trainertwin-host", version: 1, type: "visibility", open: true },
  ]));
  await page.getByRole("heading", { name: "Customer website" }).hover();
  await page.getByRole("heading", { name: "Customer website" }).click();
  await expect(page.locator("iframe")).toBeVisible();
});

test("outside clicks, Escape and minimise() reset an idle widget without hiding it; active calls ignore them", async ({ page }) => {
  await page.goto("/");
  await shown(page);
  await page.getByRole("heading", { name: "Customer website" }).click();
  await expect.poll(async () => (await received(page)).filter((item) => JSON.stringify(item) === JSON.stringify(reset)).length).toBe(1);
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.TrainerTwinWidgets!.mount({ script: document.querySelector<HTMLScriptElement>("#install")! }).minimise());
  await expect.poll(async () => (await received(page)).filter((item) => JSON.stringify(item) === JSON.stringify(reset)).length).toBe(3);
  await expect(page.locator("iframe")).toBeVisible();
  await frame(page).getByRole("button", { name: "Start fixture call" }).click();
  await expect(page.getByRole("status")).toHaveText("AI twin call in progress");
  await page.getByRole("heading", { name: "Customer website" }).click();
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.TrainerTwinWidgets!.mount({ script: document.querySelector<HTMLScriptElement>("#install")! }).minimise());
  expect((await received(page)).filter((item) => JSON.stringify(item) === JSON.stringify(reset))).toHaveLength(3);
  expect(await hostedFrame(page).evaluate("window.active")).toBe(true);
  await hostedFrame(page).evaluate(() => window.parent.postMessage({
    source: "trainertwin-widget", version: 1, type: "status", active: false,
  }, "http://127.0.0.1:43181"));
  await expect(page.getByRole("status")).toHaveText("AI twin call ended");
});

test("floating mounts remain independent and inline mode is rejected", async ({ page }) => {
  await page.goto("/");
  await shown(page);
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

test("customer styles cannot reset the card, its wrapper, or the iframe", async ({ page }) => {
  await page.goto("/");
  await shown(page);
  const before = await page.locator("iframe").boundingBox();
  await page.addStyleTag({ content: `
    body { direction: rtl; font: 60px/2 monospace; --content-height: 1px; }
    div, button, iframe { display: none !important; }
    [data-trainertwin-widget] { transform: translateX(900px) !important; opacity: 0 !important; }
  ` });
  await expect(page.locator("iframe")).toBeVisible();
  expect(await page.locator("iframe").boundingBox()).toEqual(before);
  await expect(card(page)).toHaveCSS("direction", "ltr");
  await expect(frame(page).getByRole("button", { name: "Start fixture call" })).toBeVisible();
});

test("duplicate execution per script is idempotent and destroy permits clean remount", async ({ page }) => {
  await page.goto("/");
  await shown(page);
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
  await shown(page);
  await expect(page.locator("iframe")).toHaveCount(1);
});

test("ignores wrong source, wrong origin, version and arbitrary sizing messages", async ({ page }) => {
  await page.goto("/");
  await shown(page);
  const resets = async () => (await received(page)).filter((item) => JSON.stringify(item) === JSON.stringify(reset)).length;
  await page.evaluate(() => {
    window.postMessage({ source: "trainertwin-widget", version: 1, type: "status", active: true }, window.location.origin);
  });
  const original = page.locator('iframe[title="Talk to AI twin"]');
  const before = await original.boundingBox();
  await hostedFrame(page).evaluate(() => {
    const origin = new URL(location.href).searchParams.get("parentOrigin")!;
    parent.postMessage({ source: "trainertwin-widget", version: 2, type: "status", active: true }, origin);
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
  await spoof.locator("#start").evaluate((node) => {
    if (node instanceof HTMLButtonElement) node.click();
  });
  await expect(original).toBeVisible();
  expect(await original.boundingBox()).toEqual(before);
  expect(await resets()).toBe(0);
  await expect(page.getByRole("status")).toHaveText("");
  await page.evaluate(() => {
    window.addEventListener("message", (event) => {
      if (event.origin === location.origin && event.data?.marker === "origin-check") document.body.dataset.originCheck = "received";
    });
  });
  await hostedFrame(page).goto("http://127.0.0.1:43181/attacker");
  await expect(page.locator("body")).toHaveAttribute("data-origin-check", "received");
  await expect(original).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("");
});

test("mobile card stays within the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/");
  await shown(page);
  const box = await page.locator("iframe").boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(320);
  expect(box!.y + box!.height).toBeLessThanOrEqual(568);
});

test("invalid modes, targets and script protocols fail without creating a mount", async ({ page }) => {
  await page.goto("/");
  await shown(page);
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
