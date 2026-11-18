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
  if (path !== "/manual" && !path.includes("inline")) {
    await page.getByRole("button", { name: "Talk to AI twin", exact: true }).click();
  }
  const hosted = await frame(page);
  await expect(hosted.getByRole("button", { name: "Start voice call", exact: true })).toBeEnabled();
  return hosted;
}

async function hostMessage(page: Page, type: "init" | "destroy") {
  await page.locator("iframe").evaluate((node, data) => {
    if (!(node instanceof HTMLIFrameElement) || !node.contentWindow) throw new Error("No hosted frame");
    node.contentWindow.postMessage(data.message, data.origin);
  }, { message: { ...message, type }, origin: widgetOrigin() });
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
  await hosted.getByLabel("Your name", { exact: true }).fill(name);
  await hosted.getByRole("button", { name: "Start voice call", exact: true }).click();
}

async function expectOnlySafeMessages(page: Page) {
  const messages = await page.evaluate(() => window.__widgetMessages ?? []);
  expect(messages.length).toBeGreaterThan(0);
  for (const value of messages) {
    const parsed = z.object({
      source: z.literal("trainertwin-widget"), version: z.literal(1),
      type: z.enum(["ready", "close", "status"]), active: z.boolean().optional(),
    }).strict().parse(value);
    if (parsed.type === "status") expect(typeof parsed.active).toBe("boolean");
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
    expect(await hosted.evaluate(() => (document as Document & { featurePolicy?: { allowsFeature(name: string): boolean } }).featurePolicy?.allowsFeature("microphone"))).toBe(true);
    await expect(hosted.getByLabel("Your name", { exact: true })).toHaveAttribute("maxlength", "80");
    await expect(hosted.getByText("AI voice call · Transcribed · May be recorded", { exact: true })).toBeVisible();
    await expect(hosted.locator('textarea, input[type="file"], input[type="email"], video')).toHaveCount(0);
    await expect(hosted.getByRole("button", { name: /camera|screen|upload|send message/i })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("widget-mobile-prejoin.png"), fullPage: true });
    await hosted.getByLabel("Your name", { exact: true }).fill("   ");
    await hosted.getByRole("button", { name: "Start voice call", exact: true }).click();
    await expect(hosted.getByRole("alert")).toContainText("1–80 characters");
    expect(await hosted.evaluate(() => window.__widgetMicrophoneRequests)).toBe(0);
    expect(await hosted.evaluate(() => window.__widgetFetches)).toEqual([]);
    expect(calls.starts).toHaveLength(0);
    await expectOnlySafeMessages(page);
  });

  test("denied microphone never reaches bootstrap or charged start", async ({ page, context }) => {
    await environment(context, { denyMicrophone: true });
    const calls = await simulatedCalls(page);
    const hosted = await open(page);
    await begin(hosted, "Noor");
    await expect(hosted.getByRole("alert")).toContainText("Microphone access is blocked");
    expect(await hosted.evaluate(() => window.__widgetFetches)).toEqual([]);
    expect(calls.starts).toHaveLength(0);
    await expect(hosted.getByRole("button", { name: "Start a new call", exact: true })).toBeEnabled();
  });

  test("an ancestor microphone policy blocks the real browser API before any session request", async ({ page }) => {
    let requests = 0;
    page.on("request", (request) => { if (new URL(request.url()).pathname.startsWith("/api/public/widgets/")) requests++; });
    const hosted = await open(page, "/?blockMicrophone=1");
    expect(await hosted.evaluate(() => (document as Document & { featurePolicy?: { allowsFeature(name: string): boolean } }).featurePolicy?.allowsFeature("microphone"))).toBe(false);
    await begin(hosted, "Policy check");
    await expect(hosted.getByRole("alert")).toContainText("Microphone access is blocked");
    expect(requests).toBe(0);
  });

  test("real bootstrap, double-submit lock, captions, audio, mute, minimise and end", async ({ page, context }) => {
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
    await expect(hosted.getByRole("status")).toContainText("Thinking");
    await expect(hosted.getByRole("log")).toContainText("<img src=x onerror=alert(1)> A useful answer.");
    await expect(hosted.getByRole("log").locator("img")).toHaveCount(0);
    await expect(hosted.locator(".tt-caption")).toHaveCount(2);
    await expect(hosted.locator('audio[data-widget-fixture="remote-audio"]')).toHaveCount(1);
    await hosted.evaluate(() => window.__widgetRoom?.agentState("speaking"));
    await expect(hosted.getByRole("status")).toContainText("is speaking");
    await hosted.getByRole("button", { name: "Turn on sound", exact: true }).click();
    await expect(hosted.getByRole("button", { name: "Turn on sound", exact: true })).toBeHidden();
    await hosted.getByRole("button", { name: "Mute microphone", exact: true }).click();
    await expect(hosted.getByRole("button", { name: "Unmute microphone", exact: true })).toHaveAttribute("aria-pressed", "true");
    await hosted.getByRole("button", { name: "Unmute microphone", exact: true }).click();
    expect(await hosted.evaluate(() => window.__widgetRoom?.microphone)).toEqual([true, false, true]);
    await hosted.evaluate(() => window.__widgetRoom?.reconnecting());
    await expect(hosted.getByRole("status")).toHaveText("Reconnecting your call…");
    await expect(hosted.getByRole("button", { name: "Mute microphone", exact: true })).toBeDisabled();
    await hosted.evaluate(() => window.__widgetRoom?.reconnected());
    await expect(hosted.getByRole("button", { name: "Mute microphone", exact: true })).toBeEnabled();
    await expect(hosted.getByRole("status")).toContainText("is speaking");
    expect(calls.starts).toHaveLength(1);
    expect(await hosted.evaluate(() => window.__widgetRoom?.connects)).toBe(1);
    await hosted.getByRole("button", { name: "Minimise voice widget", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "AI twin conversation", exact: true })).toBeHidden();
    expect(calls.ends).toHaveLength(0);
    await page.getByRole("button", { name: "AI twin call in progress — reopen", exact: true }).click();
    await expect(hosted.getByRole("log")).toContainText("My follow-up question");
    await hosted.evaluate(() => window.__widgetRoom?.detachAudio());
    await expect(hosted.locator("audio")).toHaveCount(0);
    await hosted.getByRole("button", { name: "End call", exact: true }).click();
    await expect(hosted.getByRole("heading", { name: "Thanks for the conversation.", exact: true })).toBeVisible();
    await expect.poll(() => calls.ends).toEqual(["Bearer end-capability-secret"]);
    expect(await hosted.evaluate(() => window.__widgetRoom?.disconnects)).toBeGreaterThanOrEqual(1);
    const requests = await hosted.evaluate(() => window.__widgetFetches ?? []);
    expect(requests.map((request) => request.path)).toContain(bootstrapPath());
    expect(requests.every((request) => request.credentials === "omit")).toBe(true);
    const stored = await hosted.evaluate(() => Object.entries(localStorage));
    expect(stored).toHaveLength(1);
    expect(stored[0][0]).toBe(visitorKey());
    expect(JSON.stringify(stored)).not.toMatch(/end-capability-secret|livekit-boundary-secret|unused-runtime-secret|Bearer/);
    await expectOnlySafeMessages(page);
  });

  test("an absolute deadline stops a still-connecting call and ends it once", async ({ page, context }) => {
    await environment(context, { pendingConnect: true });
    const calls = await simulatedCalls(page, { durationMs: 1500 });
    const hosted = await open(page);
    await begin(hosted);
    await expect(hosted.getByRole("status")).toContainText("Connecting");
    await expect(hosted.getByRole("alert")).toContainText("time limit");
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
    expect(await hosted.evaluate(() => window.__widgetRoom)).toBeUndefined();
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
    const hosted = await open(page, "/?mode=inline");
    expect(new URL(hosted.url()).searchParams.get("mode")).toBe("inline");
    await expect(hosted.getByRole("button", { name: "Minimise voice widget", exact: true })).toHaveCount(0);
    await hosted.getByLabel("Your name", { exact: true }).press("Escape");
    await expect(page.getByRole("region", { name: "AI twin conversation", exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window.__widgetMessages ?? []).some((value) =>
      typeof value === "object" && value !== null && "type" in value && value.type === "close"))).toBe(false);
    await begin(hosted);
    await expect(hosted.getByRole("alert")).toHaveText("The call service returned an unreadable response. Please try again.");
    expect(calls.starts).toHaveLength(1);
    await expect(hosted.getByRole("button", { name: "Start a new call", exact: true })).toBeEnabled();
    await hosted.getByRole("button", { name: "Start a new call", exact: true }).click();
    await begin(hosted, "Second attempt");
    await expect.poll(() => calls.starts.length).toBe(2);
    await expect(hosted.getByRole("alert")).not.toContainText("private credential");
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
    await expect(page.getByRole("button", { name: "Start voice call", exact: true })).toBeDisabled();
    await page.evaluate((data) => window.postMessage(data, window.location.origin), { ...message, type: "init" });
    await expect(page.getByRole("button", { name: "Start voice call", exact: true })).toBeDisabled();
    expect(await page.evaluate(() => window.__widgetFetches)).toEqual([]);
    await page.goto(`${CUSTOMER_ORIGIN}/manual`);
    const hosted = await frame(page);
    const start = hosted.getByRole("button", { name: "Start voice call", exact: true });
    await expect(start).toBeDisabled();
    await hosted.evaluate((data) => window.postMessage(data, window.location.origin), { ...message, type: "init" });
    await hosted.evaluate((data) => window.dispatchEvent(new MessageEvent("message", {
      data, origin: "http://attacker.localhost:43191", source: window.parent,
    })), { ...message, type: "init" });
    await expect(start).toBeDisabled();
    await hostMessage(page, "init");
    await expect(start).toBeEnabled();
    await hosted.evaluate((data) => window.dispatchEvent(new MessageEvent("message", {
      data, origin: window.location.origin, source: window.parent,
    })), { ...message, type: "destroy" });
    await expect(start).toBeEnabled();
    expect(await hosted.evaluate(() => window.__widgetFetches)).toEqual([]);
  });

  test("disallowed website and allowlist revocation fail against the actual backend", async ({ page, context, request }) => {
    await environment(context);
    const refused = await request.get(`${widgetOrigin()}/embed/${agentId}?parentOrigin=${encodeURIComponent(DISALLOWED_ORIGIN)}`);
    expect(refused.status()).toBe(403);
    expect(refused.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
    const embeddedRefusal = page.waitForResponse((response) => new URL(response.url()).pathname === `/embed/${agentId}`);
    await page.goto(DISALLOWED_ORIGIN);
    expect((await embeddedRefusal).status()).toBe(403);
    await expect(page.frameLocator("iframe").getByLabel("Your name", { exact: true })).toHaveCount(0);
    const calls = await simulatedCalls(page);
    const hosted = await open(page);
    try {
      await update(admin.request, { widget: { allowedOrigins: ["http://replacement.localhost:43191"] } });
      const denied = page.waitForResponse((response) => new URL(response.url()).pathname === bootstrapPath());
      await begin(hosted);
      expect((await denied).status()).toBe(403);
      await expect(hosted.getByRole("alert")).toContainText("not available on this website");
      expect(calls.starts).toHaveLength(0);
    } finally {
      await update(admin.request, { widget: { allowedOrigins: [CUSTOMER_ORIGIN] } });
    }
  });
});
