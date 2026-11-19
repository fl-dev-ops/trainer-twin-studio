import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test, type APIRequestContext, type BrowserContext, type Frame, type Page } from "@playwright/test";
import { z } from "zod";
import { e2eUrl } from "./env";
import { as, seed } from "./seed-data";
import { customerServer, CUSTOMER_ORIGIN, DISALLOWED_ORIGIN } from "./widget-fixtures/customer";
import type {} from "./widget-fixtures/fake-livekit";
import type {} from "../../widgets/src/loader";

const widgetConfig = z.object({
  enabled: z.boolean(), allowedOrigins: z.array(z.string()), welcome: z.string(), accentColor: z.string(),
});
const settingsResponse = z.object({
  result: z.object({ data: z.object({ json: z.object({
    publicAccess: z.object({ enabled: z.boolean(), maxSeconds: z.number() }),
    widget: z.object({ id: z.string(), config: widgetConfig }),
  }) }) }),
});
type Settings = z.infer<typeof settingsResponse>["result"]["data"]["json"];

let server: Server | undefined;
let admin: BrowserContext;
let original: Settings;
let agentId: string;
let bundle: string;
let temporary: string;
const widgetOrigin = () => new URL(e2eUrl(seed().org.slug)).origin;
const bootstrapPath = () => `/api/public/widgets/${agentId}/bootstrap`;
const sessionsPath = () => `/api/public/widgets/${agentId}/sessions`;
const visitorKey = () => `trainertwin-widget:visitor:${agentId}:${CUSTOMER_ORIGIN}`;
const message = { source: "trainertwin-host", version: 1 };

async function update(request: APIRequestContext, changes: Record<string, unknown>) {
  const response = await request.post(e2eUrl("dash", "/api/twin/agents.update?batch=1"), {
    headers: { Origin: new URL(e2eUrl("dash")).origin },
    data: { "0": { json: { slug: seed().twin.slug, ...changes } } },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

async function frame(page: Page) {
  await expect.poll(() => page.frames().some((candidate) => candidate.url().includes(`/embed/${agentId}`))).toBe(true);
  const found = page.frames().find((candidate) => candidate.url().includes(`/embed/${agentId}`));
  if (!found) throw new Error("Hosted widget iframe did not load.");
  return found;
}

async function open(page: Page, path = "/") {
  await page.goto(`${CUSTOMER_ORIGIN}${path}`);
  const hosted = await frame(page);
  await expect(introButton(hosted)).toBeEnabled();
  return hosted;
}

const introButton = (hosted: Frame) => hosted.getByRole("button", { name: "Talk to my AI twin", exact: true });

async function hostMessage(page: Page, type: "init" | "destroy") {
  await page.locator("iframe").evaluate((node, data) => {
    if (!(node instanceof HTMLIFrameElement) || !node.contentWindow) throw new Error("No hosted frame");
    node.contentWindow.postMessage(data.message, data.origin);
  }, { message: { ...message, type }, origin: widgetOrigin() });
}

async function microphonePolicy(hosted: Frame) {
  return hosted.evaluate(() => {
    const policyDocument = document as Document & {
      permissionsPolicy?: { allowsFeature(name: string): boolean };
      featurePolicy?: { allowsFeature(name: string): boolean };
    };
    return (policyDocument.permissionsPolicy ?? policyDocument.featurePolicy)?.allowsFeature("microphone");
  });
}

async function siblingMessage(page: Page, hosted: Frame, origin: string, type: "init" | "destroy") {
  await hosted.evaluate(() => {
    document.body.removeAttribute("data-message-check");
    window.addEventListener("message", (event) => {
      document.body.dataset.messageCheck = JSON.stringify({ origin: event.origin, parent: event.source === window.parent });
    }, { once: true });
  });
  const sibling = await page.evaluateHandle((origin) => {
    const node = document.createElement("iframe");
    node.src = `${origin}/message-source`;
    document.body.append(node);
    return node;
  }, origin);
  const element = sibling.asElement();
  const source = await element?.contentFrame();
  if (!source) throw new Error("Expected message source iframe");
  await source.waitForURL(`${origin}/message-source`);
  await source.evaluate((data) => {
    window.parent.frames[0].postMessage(data.message, data.origin);
  }, { message: { ...message, type }, origin: widgetOrigin() });
  await expect(hosted.locator("body")).toHaveAttribute("data-message-check", JSON.stringify({ origin, parent: false }));
  await element.evaluate((node) => node.remove());
}

async function environment(context: BrowserContext, options: { denyMicrophone?: boolean; blockedStorage?: boolean; pendingConnect?: boolean } = {}) {
  await context.addInitScript(({ options, origin }) => {
    if (window.location.origin !== origin) return;
    window.__widgetFetches = [];
    window.__widgetMicrophoneRequests = 0;
    window.__widgetConnectPending = options.pendingConnect === true;
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const request = new Request(input, init);
      window.__widgetFetches?.push({ path: new URL(request.url).pathname, credentials: request.credentials });
      return originalFetch(input, init);
    };
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => {
        window.__widgetMicrophoneRequests = (window.__widgetMicrophoneRequests ?? 0) + 1;
        if (options.denyMicrophone) throw new DOMException("Permission denied", "NotAllowedError");
        return new MediaStream();
      },
    });
    if (options.blockedStorage) {
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        get() { throw new DOMException("Third-party storage blocked", "SecurityError"); },
      });
    }
  }, { options, origin: widgetOrigin() });
}

async function simulatedCalls(page: Page, options: { pendingStart?: boolean; durationMs?: number; malformed?: boolean } = {}) {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  const starts: { name: string; authorization: string | undefined }[] = [];
  const ends: string[] = [];
  await page.route((url) => url.pathname === sessionsPath(), async (route) => {
    const body: unknown = route.request().postDataJSON();
    starts.push({ name: z.object({ name: z.string() }).parse(body).name, authorization: route.request().headers().authorization });
    if (options.pendingStart) await gate;
    if (options.malformed) {
      await route.fulfill({ contentType: "application/json", body: "{ private credential should never appear" });
      return;
    }
    const milliseconds = options.durationMs ?? 60_000;
    await route.fulfill({ json: {
      session: { id: "widget-browser-session", runtimeToken: "unused-runtime-secret", embedToken: "end-capability-secret", secondsLeft: Math.ceil(milliseconds / 1000), endsAt: Date.now() + milliseconds, serverTime: Date.now() },
      participantToken: "livekit-boundary-secret", room: "widget-browser-session",
    } });
  });
  await page.route("**/api/public/widgets/sessions/*/end", async (route) => {
    ends.push(route.request().headers().authorization ?? "");
    await route.fulfill({ json: { ok: true } });
  });
  return { starts, ends, release };
}

async function begin(hosted: Frame, name = "  Visitor Name  ") {
  const field = hosted.getByLabel("Your name", { exact: true });
  if (!await field.isVisible()) await introButton(hosted).click();
  await field.fill(name);
  await field.press("Enter");
}

async function expectPortraitInsets(hosted: Frame) {
  await expect.poll(() => hosted.locator(".tt-portrait-stage").evaluate((node) => {
    const card = document.querySelector(".tt-card")!.getBoundingClientRect();
    const portrait = node.getBoundingClientRect();
    return {
      left: Math.round(portrait.left - card.left),
      right: Math.round(card.right - portrait.right),
      top: Math.round(portrait.top - card.top),
    };
  })).toEqual({ left: 16, right: 16, top: 16 });
}

async function expectNoCardScroll(hosted: Frame) {
  await expect.poll(() => hosted.evaluate(() => {
    const card = document.querySelector(".tt-card");
    const body = document.querySelector(".tt-body");
    if (!card || !body) return false;
    return card.getBoundingClientRect().height <= innerHeight + 1
      && body.scrollHeight <= body.clientHeight + 1
      && document.documentElement.scrollHeight <= innerHeight + 1;
  })).toBe(true);
}

async function expectCallControlsFit(hosted: Frame) {
  for (const name of ["Mute microphone", "End call"]) {
    await expect.poll(() => hosted.getByRole("button", { name, exact: true }).evaluate((node) => {
      const bounds = node.getBoundingClientRect();
      const card = node.closest(".tt-card")?.getBoundingClientRect();
      return !!card && bounds.top >= 0 && bounds.bottom <= card.bottom && card.bottom <= innerHeight + 1;
    })).toBe(true);
  }
  await expectNoCardScroll(hosted);
}

async function expectOnlySafeMessages(page: Page) {
  const messages = await page.evaluate(() => window.__widgetMessages ?? []);
  expect(messages.length).toBeGreaterThan(0);
  for (const value of messages) {
    const parsed = z.object({
      source: z.literal("trainertwin-widget"), version: z.literal(1),
      type: z.enum(["ready", "close", "status", "interaction", "resize"]), intro: z.boolean().optional(), active: z.boolean().optional(), editing: z.boolean().optional(),
      height: z.number().int().min(140).max(4096).optional(),
    }).strict().parse(value);
    if (parsed.type === "status") expect(typeof parsed.active).toBe("boolean");
    if (parsed.type === "interaction") expect(typeof parsed.editing).toBe("boolean");
    if (parsed.type === "resize") expect(typeof parsed.height).toBe("number");
  }
  expect(JSON.stringify(messages)).not.toMatch(/secret|Bearer|grant|visitorToken|participantToken|embedToken|runtimeToken/);
}

test.describe.serial("cross-origin hosted voice widget", () => {
  test.beforeAll(async ({ browser }) => {
    await mkdir(resolve(tmpdir(), "opencode"), { recursive: true });
    temporary = await mkdtemp(resolve(tmpdir(), "opencode", "trainertwin-widget-browser-"));
    const output = resolve(temporary, "voice.js");
    await promisify(execFile)("bun", [resolve("../widgets/e2e/build-hosted.ts"), output], { cwd: process.cwd() });
    bundle = await readFile(output, "utf8");
    admin = await browser.newContext(as("admin"));
    const response = await admin.request.get(e2eUrl("dash", `/api/twin/agents.get?input=${encodeURIComponent(JSON.stringify({ json: { slug: seed().twin.slug } }))}`));
    expect(response.ok(), await response.text()).toBe(true);
    original = settingsResponse.parse(await response.json()).result.data.json;
    agentId = original.widget.id;
    await update(admin.request, {
      publicAccess: { enabled: true, maxSeconds: 120 },
      widget: { enabled: true, allowedOrigins: [CUSTOMER_ORIGIN], welcome: "A conversation with your AI twin", accentColor: "#35482e" },
    });
    server = await customerServer(widgetOrigin(), agentId);
  });

  test.afterAll(async () => {
    if (admin && original) {
      await update(admin.request, { publicAccess: original.publicAccess, widget: original.widget.config });
    }
    if (admin) await admin.close();
    if (server) await new Promise<void>((done, reject) => server?.close((error) => error ? reject(error) : done()));
    if (temporary) await rm(temporary, { recursive: true });
  });

  test.beforeEach(async ({ page }) => {
    await page.route("**/widgets/voice-v1.js", (route) => route.fulfill({
      contentType: "text/javascript; charset=utf-8", body: bundle,
    }));
  });

  test("real embed CSP and loader render a narrow prejoin without starting anything", async ({ page, context }, testInfo) => {
    await environment(context);
    await page.setViewportSize({ width: 360, height: 740 });
    const calls = await simulatedCalls(page);
    const embedResponse = page.waitForResponse((response) => new URL(response.url()).pathname === `/embed/${agentId}`);
    const hosted = await open(page);
    const response = await embedResponse;
    expect(response.status()).toBe(200);
    expect(response.headers()["content-security-policy"]).toContain(`frame-ancestors ${CUSTOMER_ORIGIN}`);
    expect(response.headers()["content-security-policy"]).toContain("default-src 'none'");
    expect(response.headers()["content-security-policy"]).toContain("form-action 'none'");
    const sandbox = await page.locator("iframe").getAttribute("sandbox");
    expect(sandbox?.split(" ")).toEqual(expect.arrayContaining(["allow-scripts", "allow-same-origin", "allow-forms"]));
    expect(sandbox).not.toMatch(/allow-top-navigation|allow-popups/);
    await expect(page.locator("iframe")).toHaveAttribute("allow", `microphone ${widgetOrigin()}`);
    const microphoneAllowed = await microphonePolicy(hosted);
    if (microphoneAllowed !== undefined) expect(microphoneAllowed).toBe(true);
    await introButton(hosted).click();
    await expect(hosted.getByLabel("Your name", { exact: true })).toHaveAttribute("maxlength", "80");
    await expect(hosted.locator(".tt-consent, .tt-allowance")).toHaveCount(0);
    await expect(hosted.locator("details")).toHaveCount(0);
    const inlineResponse = await page.request.get(`${widgetOrigin()}/embed/${agentId}?parentOrigin=${encodeURIComponent(CUSTOMER_ORIGIN)}&mode=inline`);
    expect(inlineResponse.status()).toBe(400);
    await expect(hosted.locator('textarea, input[type="file"], input[type="email"], video')).toHaveCount(0);
    await expect(hosted.getByRole("button", { name: /camera|screen|upload|send message/i })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("widget-mobile-prejoin.png"), fullPage: true, animations: "disabled" });
    await hosted.getByLabel("Your name", { exact: true }).fill("   ");
    await hosted.getByLabel("Your name", { exact: true }).press("Enter");
    await expect(hosted.getByRole("alert")).toContainText("1–80 characters");
    expect(await hosted.evaluate(() => window.__widgetMicrophoneRequests)).toBe(0);
    expect(await hosted.evaluate(() => window.__widgetFetches)).toEqual([]);
    expect(calls.starts).toHaveLength(0);
    await expectOnlySafeMessages(page);
  });

  test("denied microphone never reaches bootstrap or charged start", async ({ page, context }, testInfo) => {
    await environment(context, { denyMicrophone: true });
    const calls = await simulatedCalls(page);
    const hosted = await open(page);
    await begin(hosted, "Noor");
    await expect(hosted.getByRole("heading", { name: "We couldn’t start the conversation.", exact: true }))
      .toHaveAttribute("aria-description", /Microphone access is blocked/);
    expect(await hosted.evaluate(() => window.__widgetFetches)).toEqual([]);
    expect(calls.starts).toHaveLength(0);
    await expect(hosted.getByRole("heading", { name: "We couldn’t start the conversation.", exact: true })).toBeVisible();
    await expect(hosted.getByRole("button", { name: "Try again", exact: true })).toBeEnabled();
    await expectNoCardScroll(hosted);
    await page.locator("[data-trainertwin-widget] .floating").screenshot({ path: testInfo.outputPath("widget-microphone-denied.png"), animations: "disabled" });
  });

  test("name entry has no portrait and dismisses without starting a call", async ({ page, context }) => {
    await environment(context);
    const hosted = await open(page);
    await introButton(hosted).click();
    await expect(hosted.locator(".tt-portrait-stage")).toBeHidden();
    await hosted.getByLabel("Your name", { exact: true }).fill("First visitor");
    await hosted.getByRole("button", { name: "Close widget" }).click();
    await expect(introButton(hosted)).toBeFocused();
    expect(await hosted.evaluate(() => window.__widgetMicrophoneRequests)).toBe(0);
    await expectOnlySafeMessages(page);
  });

  test("portrait-led design keeps name entry, captions and controls usable across call states", async ({ page, context, browserName }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 1000 });
    await environment(context);
    const calls = await simulatedCalls(page, { pendingStart: true });
    await page.route((url) => url.pathname === `/embed/${agentId}`, async (route) => {
      const response = await route.fetch();
      const html = await response.text();
      expect(html).toContain('"photoUrl":null');
      await route.fulfill({ response, body: html.replace('"photoUrl":null', `"photoUrl":"${widgetOrigin()}/vasanth.png"`) });
    });
    await page.goto(CUSTOMER_ORIGIN);
    const prefetched = await frame(page);
    await expect.poll(() => prefetched.locator(".tt-hero-portrait .tt-photo").evaluate((node) =>
      node instanceof HTMLImageElement && node.complete && node.naturalWidth > 0)).toBe(true);
    await expect(prefetched.locator(".tt-hero-portrait .tt-photo")).toHaveAttribute("loading", "eager");
    await expect(prefetched.locator(".tt-hero-portrait .tt-photo")).toHaveAttribute("fetchpriority", "high");
    const hosted = prefetched;
    await introButton(hosted).click();
    await expect(hosted.getByRole("textbox", { name: "Your name" })).toBeVisible();
    const photo = hosted.locator(".tt-hero-portrait img");
    await expect(photo).toBeHidden();
    await expectNoCardScroll(hosted);
    await page.locator("[data-trainertwin-widget] .floating").screenshot({ path: testInfo.outputPath("widget-desktop-portrait.png"), animations: "disabled" });
    if (browserName === "chromium") {
      const client = await context.newCDPSession(hosted);
      try {
        await client.send("DOM.enable");
        await client.send("CSS.enable");
        await hosted.getByLabel("Your name", { exact: true }).fill("Surya Umapathy");
        const { root } = await client.send("DOM.getDocument");
        const { nodeId } = await client.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#tt-visitor-name" });
        expect(nodeId).not.toBe(0);
        await client.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["autofill"] });
        await expect(hosted.getByLabel("Your name", { exact: true })).toHaveValue("Surya Umapathy");
        expect(await hosted.getByLabel("Your name", { exact: true }).evaluate((node) => node.matches(":autofill"))).toBe(true);
        expect(await hosted.getByLabel("Your name", { exact: true }).evaluate((node) => getComputedStyle(node).backgroundClip)).toBe("text");
        await page.locator("[data-trainertwin-widget] .floating").screenshot({ path: testInfo.outputPath("widget-autofilled.png"), animations: "disabled" });
        await client.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });
      } finally {
        await client.detach();
      }
    }
    await expect(hosted.getByRole("button", { name: "Minimise voice widget", exact: true })).toHaveCount(0);
    await begin(hosted, "Design review");
    await expect.poll(() => calls.starts.length).toBe(1);
    await expect(hosted.getByRole("status")).toHaveText("Connecting…");
    await expect(hosted.locator(".tt-transcript")).toBeHidden();
    await expect(hosted.locator("header")).toHaveCount(0);
    expect(await photo.evaluate((node) => getComputedStyle(node).objectFit)).toBe("cover");
    expect(await hosted.locator(".tt-portrait-stage").evaluate((node) => Math.abs(node.clientWidth - node.clientHeight))).toBeLessThanOrEqual(1);
    await expectPortraitInsets(hosted);
    await expectCallControlsFit(hosted);
    await page.locator("[data-trainertwin-widget] .floating").screenshot({ path: testInfo.outputPath("widget-starting-call.png"), animations: "disabled" });
    calls.release();
    await expect(hosted.getByRole("button", { name: "Mute microphone", exact: true })).toBeEnabled();
    await hosted.evaluate(() => {
      window.__widgetRoom?.agentState("speaking");
      window.__widgetRoom?.caption("opening", "Tell me about the conversation you are preparing for.");
      window.__widgetRoom?.caption("question", "How should I approach this conversation?", "visitor");
      window.__widgetRoom?.caption("answer", "Start by listening. What matters most to the person you are speaking with?");
    });
    await expect(hosted.locator(".tt-card")).toHaveAttribute("data-agent-state", "speaking");
    await expect(hosted.locator(".tt-status")).toBeHidden();
    await expectPortraitInsets(hosted);
    await expect(hosted.getByRole("button", { name: "Turn on sound", exact: true })).toHaveCount(0);
    await hosted.evaluate(() => {
      window.__widgetRoom?.attachAudio();
      window.__widgetRoom?.levels(0.4, 0);
    });
    await expect.poll(() => hosted.locator(".tt-waves").evaluate((node) => node instanceof HTMLCanvasElement && node.width > 0)).toBe(true);
    await expect(hosted.locator(".tt-caption:visible")).toHaveCount(2);
    expect(await hosted.locator(".tt-caption").last().evaluate((node) => getComputedStyle(node).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
    await expect.poll(() => hosted.locator(".tt-waves").evaluate((node) => {
      if (!(node instanceof HTMLCanvasElement)) return false;
      const color = node.getContext("2d")?.getImageData(node.width / 2, node.height - 60 * devicePixelRatio, 1, 1).data;
      return color !== undefined && color[1] > color[0];
    })).toBe(true);
    await page.locator("[data-trainertwin-widget] .floating").screenshot({ path: testInfo.outputPath("widget-desktop-speaking.png"), animations: "disabled" });
    await hosted.evaluate(() => window.__widgetRoom?.levels(0, 0.4));
    await expect.poll(() => hosted.locator(".tt-waves").evaluate((node) => {
      if (!(node instanceof HTMLCanvasElement)) return false;
      const color = node.getContext("2d")?.getImageData(node.width / 2, node.height - 60 * devicePixelRatio, 1, 1).data;
      return color !== undefined && color[0] > color[1];
    })).toBe(true);
    await page.locator("[data-trainertwin-widget] .floating").screenshot({ path: testInfo.outputPath("widget-visitor-speaking.png"), animations: "disabled" });
    await page.setViewportSize({ width: 1280, height: 480 });
    await expectCallControlsFit(hosted);
    await page.locator("[data-trainertwin-widget] .floating").screenshot({ path: testInfo.outputPath("widget-short-call.png"), animations: "disabled" });
    await expect(hosted.getByRole("button", { name: "Expand captions" })).toHaveCount(0);
    await expect(hosted.locator(".tt-caption:visible")).toHaveCount(2);
    await expect(hosted.locator(".tt-portrait-stage")).toBeVisible();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect.poll(() => hosted.locator(".tt-caption").last().evaluate((node) => getComputedStyle(node).animationName)).toBe("none");
    await hosted.getByRole("button", { name: "End call", exact: true }).click();
    await expect.poll(() => calls.ends.length).toBe(1);
    await expect(introButton(hosted)).toBeFocused();
    expect(calls.starts).toHaveLength(1);
    await page.setViewportSize({ width: 320, height: 568 });
    await expect(introButton(hosted)).toBeVisible();
    expect(await hosted.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await photo.evaluate((node) => node.dispatchEvent(new Event("error")));
    await expect(photo).toHaveCount(0);
    await expect(hosted.locator(".tt-hero-portrait")).toHaveText("ET");
    await expectOnlySafeMessages(page);
  });

  test("a failed start shows a friendly retry screen without scrolling or claiming a completed call", async ({ page, context }, testInfo) => {
    await environment(context);
    await page.route((url) => url.pathname === `/embed/${agentId}`, async (route) => {
      const response = await route.fetch();
      const html = await response.text();
      await route.fulfill({ response, body: html.replace('"photoUrl":null', `"photoUrl":"${widgetOrigin()}/vasanth.png"`) });
    });
    const calls = await simulatedCalls(page);
    const failedPath = `**${sessionsPath()}`;
    await page.route(failedPath, (route) => route.abort("failed"));
    const hosted = await open(page);
    await begin(hosted, "Retry visitor");
    await expect(hosted.getByRole("heading", { name: "We couldn’t start the conversation.", exact: true })).toBeVisible();
    await expect(hosted.getByRole("heading", { name: "We couldn’t start the conversation.", exact: true }))
      .toHaveAttribute("aria-description", "Please try again in a little while.");
    await expect(hosted.getByRole("heading", { name: "Thanks for the conversation.", exact: true })).toHaveCount(0);
    await expect(hosted.locator(".tt-error")).toBeHidden();
    await expect(hosted.getByRole("button", { name: "Try again", exact: true })).toBeEnabled();
    await expectPortraitInsets(hosted);
    await expectNoCardScroll(hosted);
    await page.locator("[data-trainertwin-widget] .floating").screenshot({ path: testInfo.outputPath("widget-start-failed.png"), animations: "disabled" });
    await page.setViewportSize({ width: 1280, height: 480 });
    await expectNoCardScroll(hosted);
    await page.locator("[data-trainertwin-widget] .floating").screenshot({ path: testInfo.outputPath("widget-short-failed.png"), animations: "disabled" });
    await page.unroute(failedPath);
    await hosted.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(hosted.getByRole("button", { name: "Mute microphone", exact: true })).toBeEnabled();
    await expectCallControlsFit(hosted);
    await hosted.getByRole("button", { name: "End call", exact: true }).click();
    await expect.poll(() => calls.ends.length).toBe(1);
    expect(calls.starts).toHaveLength(1);
    await expectOnlySafeMessages(page);
  });

  test("an ancestor microphone policy blocks the real browser API before any session request", async ({ page }) => {
    let requests = 0;
    page.on("request", (request) => { if (new URL(request.url()).pathname.startsWith("/api/public/widgets/")) requests++; });
    const hosted = await open(page, "/?blockMicrophone=1");
    const microphoneAllowed = await microphonePolicy(hosted);
    test.skip(microphoneAllowed === undefined, "Browser does not expose Permissions Policy introspection; native microphone policy denial is not verified here.");
    expect(microphoneAllowed).toBe(false);
    await begin(hosted, "Policy check");
    await expect(hosted.getByRole("alert")).toContainText("Microphone access is blocked");
    expect(requests).toBe(0);
  });

  test("real bootstrap, double-submit lock, captions, audio, mute, keep-open and end", async ({ page, context }) => {
    await environment(context);
    const calls = await simulatedCalls(page, { pendingStart: true });
    const hosted = await open(page);
    const bootstrapResponse = page.waitForResponse((response) => new URL(response.url()).pathname === bootstrapPath());
    await begin(hosted);
    expect((await bootstrapResponse).status()).toBe(200);
    await expect.poll(() => calls.starts.length).toBe(1);
    await hosted.locator("form").evaluate((form) => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(calls.starts).toHaveLength(1);
    expect(calls.starts[0].name).toBe("Visitor Name");
    expect(calls.starts[0].authorization).toMatch(/^Bearer [A-Za-z0-9_.-]+$/);
    calls.release();
    await expect(hosted.getByRole("button", { name: "Mute microphone", exact: true })).toBeEnabled();
    expect(await hosted.evaluate(() => window.__widgetRoom?.microphone)).toEqual([true]);
    await hosted.evaluate(() => {
      window.__widgetRoom?.agentState("thinking");
      window.__widgetRoom?.caption("turn-1", "Let’s think");
      window.__widgetRoom?.caption("turn-1", "<img src=x onerror=alert(1)> A useful answer.");
      window.__widgetRoom?.caption("visitor-1", "My follow-up question", "visitor");
      window.__widgetRoom?.attachAudio();
    });
    await expect(hosted.locator(".tt-card")).toHaveAttribute("data-agent-state", "thinking");
    await expect(hosted.locator(".tt-status")).toBeHidden();
    await expect(hosted.getByRole("log")).toContainText("<img src=x onerror=alert(1)> A useful answer.");
    await expect(hosted.getByRole("log").locator("img")).toHaveCount(0);
    await expect(hosted.locator(".tt-caption")).toHaveCount(2);
    await expect(hosted.locator('audio[data-widget-fixture="remote-audio"]')).toHaveCount(1);
    await hosted.evaluate(() => window.__widgetRoom?.agentState("speaking"));
    await expect(hosted.locator(".tt-card")).toHaveAttribute("data-agent-state", "speaking");
    expect(await hosted.evaluate(() => window.__widgetRoom?.audioStarts)).toBe(1);
    await hosted.evaluate(() => window.__widgetRoom?.blockPlayback());
    await expect(hosted.getByRole("alert")).toContainText("Tap the widget");
    await hosted.locator(".tt-hero-portrait").click();
    await expect(hosted.getByRole("alert")).toBeHidden();
    expect(await hosted.evaluate(() => window.__widgetRoom?.audioStarts)).toBe(2);
    await hosted.getByRole("button", { name: "Mute microphone", exact: true }).click();
    await expect(hosted.getByRole("button", { name: "Unmute microphone", exact: true })).toHaveAttribute("aria-pressed", "true");
    await hosted.getByRole("button", { name: "Unmute microphone", exact: true }).click();
    expect(await hosted.evaluate(() => window.__widgetRoom?.microphone)).toEqual([true, false, true]);
    await hosted.evaluate(() => window.__widgetRoom?.reconnecting());
    await expect(hosted.getByRole("status")).toHaveText("Connecting…");
    await expect(hosted.getByRole("button", { name: "Mute microphone", exact: true })).toBeDisabled();
    await hosted.evaluate(() => window.__widgetRoom?.reconnected());
    await expect(hosted.getByRole("button", { name: "Mute microphone", exact: true })).toBeEnabled();
    await expect(hosted.locator(".tt-status")).toBeHidden();
    expect(calls.starts).toHaveLength(1);
    expect(await hosted.evaluate(() => window.__widgetRoom?.connects)).toBe(1);
    await expect(hosted.getByRole("button", { name: "Minimise voice widget", exact: true })).toHaveCount(0);
    await page.getByRole("heading", { name: "Independent customer website" }).hover();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "AI twin conversation", exact: true })).toBeVisible();
    expect(calls.ends).toHaveLength(0);
    await expect(hosted.getByRole("log")).toContainText("My follow-up question");
    await hosted.evaluate(() => window.__widgetRoom?.detachAudio());
    await expect(hosted.locator("audio")).toHaveCount(0);
    await hosted.getByRole("button", { name: "End call", exact: true }).click();
    await expect(introButton(hosted)).toBeFocused();
    await expect.poll(() => calls.ends).toEqual(["Bearer end-capability-secret"]);
    expect(await hosted.evaluate(() => window.__widgetRoom?.disconnects)).toBeGreaterThanOrEqual(1);
    const requests = await hosted.evaluate(() => window.__widgetFetches ?? []);
    expect(requests.map((request) => request.path)).toContain(bootstrapPath());
    expect(requests.every((request) => request.credentials === "omit")).toBe(true);
    const stored = await hosted.evaluate(() => Object.entries(localStorage));
    expect(Object.fromEntries(stored)).toEqual({
      [visitorKey()]: expect.any(String),
      [`trainertwin-widget:name:${agentId}:${CUSTOMER_ORIGIN}`]: "Visitor Name",
    });
    expect(JSON.stringify(stored)).not.toMatch(/end-capability-secret|livekit-boundary-secret|unused-runtime-secret|Bearer/);
    await expectOnlySafeMessages(page);
  });

  test("remembers the visitor name across reloads and lets them change it", async ({ page, context }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await environment(context);
    const calls = await simulatedCalls(page);
    const hosted = await open(page);
    await begin(hosted, "Visitor One");
    await expect(hosted.getByRole("button", { name: "Mute microphone", exact: true })).toBeEnabled();
    await hosted.getByRole("button", { name: "End call" }).click();
    await expect.poll(() => calls.ends.length).toBe(1);
    const returning = await open(page);
    await expect(returning.getByRole("textbox", { name: "Your name" })).toBeHidden();
    await introButton(returning).click();
    await expect(returning.getByRole("button", { name: "Mute microphone", exact: true })).toBeEnabled();
    await returning.getByRole("button", { name: "End call" }).click();
    await expect.poll(() => calls.ends.length).toBe(2);
    await expect(introButton(returning)).toBeFocused();
    await returning.getByRole("button", { name: "Change your name" }).press("Enter");
    await expect(returning.getByRole("textbox", { name: "Your name" })).toHaveValue("Visitor One");
    await begin(returning, "Visitor Two");
    await expect(returning.getByRole("button", { name: "Mute microphone", exact: true })).toBeEnabled();
    await returning.getByRole("button", { name: "End call" }).click();
    await expect.poll(() => calls.ends.length).toBe(3);
    expect(calls.starts.map((call) => call.name)).toEqual(["Visitor One", "Visitor One", "Visitor Two"]);
    const edited = await open(page);
    await edited.getByRole("button", { name: "Change your name" }).click();
    await expect(edited.getByRole("textbox", { name: "Your name" })).toHaveValue("Visitor Two");
  });

  test("a dropped connection ends the call without a redundant alert", async ({ page, context }) => {
    await environment(context);
    const calls = await simulatedCalls(page);
    const hosted = await open(page);
    await begin(hosted);
    await expect(hosted.getByRole("button", { name: "Mute microphone", exact: true })).toBeEnabled();
    await hosted.evaluate(() => window.__widgetRoom?.dropConnection());
    await expect(introButton(hosted)).toBeFocused();
    await expect(hosted.getByRole("alert")).toBeHidden();
    await expect.poll(() => calls.ends).toEqual(["Bearer end-capability-secret"]);
  });

  test("an absolute deadline stops a still-connecting call and ends it once", async ({ page, context }) => {
    await environment(context, { pendingConnect: true });
    const calls = await simulatedCalls(page, { durationMs: 1500 });
    const hosted = await open(page);
    await begin(hosted);
    await expect(hosted.getByRole("status")).toContainText("Connecting");
    await expect(hosted.getByRole("heading", { name: "We couldn’t start the conversation.", exact: true }))
      .toHaveAttribute("aria-description", /time limit/);
    await expect.poll(() => calls.ends).toEqual(["Bearer end-capability-secret"]);
    expect(await hosted.evaluate(() => window.__widgetRoom?.disconnects)).toBeGreaterThanOrEqual(1);
    expect(await hosted.evaluate(() => window.__widgetRoom?.microphone)).toEqual([]);
  });

  test("a skewed device wall clock does not end a valid server allowance early", async ({ page, context }) => {
    await environment(context);
    await page.clock.setFixedTime(new Date("2040-01-01T00:00:00Z"));
    const calls = await simulatedCalls(page);
    const hosted = await open(page);
    await begin(hosted);
    await expect(hosted.getByRole("button", { name: "Mute microphone", exact: true })).toBeEnabled();
    expect(calls.ends).toHaveLength(0);
    await expect(hosted.getByRole("alert")).toBeHidden();
    await hosted.getByRole("button", { name: "End call", exact: true }).click();
    await expect.poll(() => calls.ends.length).toBe(1);
  });

  test("destroy during a pending charged start ends the late session without connecting", async ({ page, context }) => {
    await environment(context);
    const calls = await simulatedCalls(page, { pendingStart: true });
    const hosted = await open(page);
    await begin(hosted);
    await expect.poll(() => calls.starts.length).toBe(1);
    // Keep the frame alive to observe the best-effort cleanup response; real removal is server-deadline backed.
    await hostMessage(page, "destroy");
    await expect(hosted.locator("#trainertwin-widget")).toBeEmpty();
    calls.release();
    await expect.poll(() => calls.ends).toEqual(["Bearer end-capability-secret"]);
    expect(await hosted.evaluate(() => window.__widgetRoom?.connects)).toBe(0);
    expect(await hosted.evaluate(() => window.__widgetRoom?.microphone)).toEqual([]);
    expect(await hosted.evaluate(() => window.__widgetRoom?.disconnects)).toBeGreaterThanOrEqual(1);
  });

  test("actual loader destruction removes a frame with a pending start", async ({ page, context }) => {
    await environment(context);
    const calls = await simulatedCalls(page, { pendingStart: true });
    const hosted = await open(page);
    await begin(hosted);
    await expect.poll(() => calls.starts.length).toBe(1);
    await page.evaluate(() => {
      const script = document.querySelector("script[data-twin-id]");
      if (!(script instanceof HTMLScriptElement)) throw new Error("Expected the installed widget script");
      window.TrainerTwinWidgets?.destroy(script);
    });
    await expect(page.locator("iframe")).toHaveCount(0);
    expect(hosted.isDetached()).toBe(true);
    calls.release();
    await expect(page.locator("[data-trainertwin-widget]")).toHaveCount(0);
    expect(calls.starts).toHaveLength(1);
  });

  test("forged visitor identity is rejected by real bootstrap and retried once without it", async ({ page, context }) => {
    await environment(context);
    const calls = await simulatedCalls(page);
    const hosted = await open(page);
    await hosted.evaluate((key) => localStorage.setItem(key, "forged.visitor.token"), visitorKey());
    const bootstraps: { status: number; body: unknown }[] = [];
    page.on("response", async (response) => {
      if (new URL(response.url()).pathname === bootstrapPath()) {
        bootstraps.push({ status: response.status(), body: response.request().postDataJSON() });
      }
    });
    await begin(hosted);
    await expect(hosted.getByRole("button", { name: "Mute microphone", exact: true })).toBeEnabled();
    await expect.poll(() => bootstraps.length).toBe(2);
    expect(bootstraps).toEqual([
      { status: 401, body: { parentOrigin: CUSTOMER_ORIGIN, visitorToken: "forged.visitor.token" } },
      { status: 200, body: { parentOrigin: CUSTOMER_ORIGIN } },
    ]);
    expect(calls.starts).toHaveLength(1);
    expect(await hosted.evaluate((key) => localStorage.getItem(key), visitorKey())).not.toBe("forged.visitor.token");
    await hosted.getByRole("button", { name: "End call", exact: true }).click();
    await expect.poll(() => calls.ends.length).toBe(1);
  });

  test("blocked third-party storage falls back to memory and malformed starts stay generic", async ({ page, context }) => {
    await environment(context, { blockedStorage: true });
    const calls = await simulatedCalls(page, { malformed: true });
    const bootstraps: unknown[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === bootstrapPath()) bootstraps.push(request.postDataJSON());
    });
    const hosted = await open(page);
    expect(new URL(hosted.url()).searchParams.get("mode")).toBe("floating");
    await begin(hosted);
    await expect(hosted.getByRole("heading", { name: "We couldn’t start the conversation.", exact: true }))
      .toHaveAttribute("aria-description", "Please try again in a little while.");
    expect(calls.starts).toHaveLength(1);
    await expect(hosted.getByRole("button", { name: "Try again", exact: true })).toBeEnabled();
    await hosted.getByRole("button", { name: "Try again", exact: true }).click();
    await expect.poll(() => calls.starts.length).toBe(2);
    expect(await hosted.locator(".tt-call-title").getAttribute("aria-description")).not.toContain("private credential");
    expect(bootstraps).toEqual([
      { parentOrigin: CUSTOMER_ORIGIN },
      { parentOrigin: CUSTOMER_ORIGIN, visitorToken: expect.any(String) },
    ]);
    expect((await hosted.evaluate(() => window.__widgetFetches ?? [])).every((request) => request.credentials === "omit")).toBe(true);
  });

  test("direct navigation and untrusted message source or origin cannot initialize the widget", async ({ page, context }) => {
    await environment(context);
    const direct = `${widgetOrigin()}/embed/${agentId}?parentOrigin=${encodeURIComponent(CUSTOMER_ORIGIN)}`;
    await page.goto(direct);
    await expect(page.getByRole("button", { name: "Talk to my AI twin", exact: true })).toBeDisabled();
    await page.evaluate((data) => window.postMessage(data, window.location.origin), { ...message, type: "init" });
    await expect(page.getByRole("button", { name: "Talk to my AI twin", exact: true })).toBeDisabled();
    expect(await page.evaluate(() => window.__widgetFetches)).toEqual([]);
    await page.goto(`${CUSTOMER_ORIGIN}/manual`);
    const hosted = await frame(page);
    const start = introButton(hosted);
    await expect(start).toBeDisabled();
    await hosted.evaluate((data) => window.postMessage(data, window.location.origin), { ...message, type: "init" });
    await siblingMessage(page, hosted, CUSTOMER_ORIGIN, "init");
    await siblingMessage(page, hosted, DISALLOWED_ORIGIN, "init");
    await expect(start).toBeDisabled();
    await hostMessage(page, "init");
    await expect(start).toBeEnabled();
    await siblingMessage(page, hosted, CUSTOMER_ORIGIN, "destroy");
    await siblingMessage(page, hosted, DISALLOWED_ORIGIN, "destroy");
    await expect(start).toBeEnabled();
    expect(await hosted.evaluate(() => window.__widgetFetches)).toEqual([]);
    try {
      await update(admin.request, { widget: { allowedOrigins: [CUSTOMER_ORIGIN, DISALLOWED_ORIGIN] } });
      await page.goto(`${DISALLOWED_ORIGIN}/manual`);
      const wrongParent = await frame(page);
      await expect(introButton(wrongParent)).toBeDisabled();
      await wrongParent.evaluate(() => {
        window.addEventListener("message", (event) => {
          document.body.dataset.messageCheck = JSON.stringify({ origin: event.origin, parent: event.source === window.parent });
        }, { once: true });
      });
      await hostMessage(page, "init");
      await expect(wrongParent.locator("body")).toHaveAttribute("data-message-check", JSON.stringify({ origin: DISALLOWED_ORIGIN, parent: true }));
      await expect(introButton(wrongParent)).toBeDisabled();
      expect(await wrongParent.evaluate(() => window.__widgetFetches)).toEqual([]);
    } finally {
      await update(admin.request, { widget: { allowedOrigins: [CUSTOMER_ORIGIN] } });
    }
  });

  test("disallowed website and allowlist revocation fail against the actual backend", async ({ page, context, request }) => {
    await environment(context);
    const refused = await request.get(`${widgetOrigin()}/embed/${agentId}?parentOrigin=${encodeURIComponent(DISALLOWED_ORIGIN)}`);
    expect(refused.status()).toBe(403);
    expect(refused.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(await refused.text()).not.toContain("trainertwin-config");
    const voiceRequests: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/widgets/voice-v1.js") voiceRequests.push(request.url());
    });
    const embeddedRefusal = page.waitForResponse((response) => new URL(response.url()).pathname === `/embed/${agentId}`);
    await page.goto(DISALLOWED_ORIGIN);
    const embedded = await embeddedRefusal;
    expect(embedded.status()).toBe(403);
    expect(embedded.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(voiceRequests).toEqual([]);
    expect(await page.evaluate(() => window.__widgetMessages)).toEqual([]);
    const calls = await simulatedCalls(page);
    const hosted = await open(page);
    try {
      await update(admin.request, { widget: { allowedOrigins: ["http://replacement.localhost:43191"] } });
      const denied = page.waitForResponse((response) => new URL(response.url()).pathname === bootstrapPath());
      await begin(hosted);
      expect((await denied).status()).toBe(403);
      await expect(hosted.getByRole("heading", { name: "We couldn’t start the conversation.", exact: true }))
        .toHaveAttribute("aria-description", /not available on this website/);
      expect(calls.starts).toHaveLength(0);
    } finally {
      await update(admin.request, { widget: { allowedOrigins: [CUSTOMER_ORIGIN] } });
    }
  });
});
