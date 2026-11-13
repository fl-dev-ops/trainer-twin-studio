import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";

const actor = { id: "org", slug: "acme", name: "Acme", role: "admin", accentColor: null, user: { id: "trainer", name: "Trainer", email: "trainer@example.com" } };
let owner = { orgId: actor.id, userId: actor.user.id };
const lookup = mock(async (_input: unknown) => owner);
mock.module("@/lib/org", () => ({ getTrainerOrg: async () => actor }));
mock.module("@/lib/db", () => ({ db: { copilotSession: { findUnique: lookup } } }));
const { GET } = await import("@/app/api/eve/v1/[[...path]]/route");
const original = { origin: process.env.EVE_ORIGIN, secret: process.env.COPILOT_SERVICE_SECRET };
let upstream: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
beforeEach(() => {
  process.env.EVE_ORIGIN = "https://eve.example.com"; process.env.COPILOT_SERVICE_SECRET = "server-secret";
  owner = { orgId: actor.id, userId: actor.user.id }; lookup.mockClear();
  upstream = spyOn(globalThis, "fetch").mockResolvedValue(new Response("data: hello\n\n", { headers: { "content-type": "text/event-stream", "set-cookie": "secret=upstream" } }));
});
afterEach(() => {
  upstream.mockRestore();
  if (original.origin === undefined) delete process.env.EVE_ORIGIN; else process.env.EVE_ORIGIN = original.origin;
  if (original.secret === undefined) delete process.env.COPILOT_SERVICE_SECRET; else process.env.COPILOT_SERVICE_SECRET = original.secret;
});
const call = (path: string[]) => GET(new Request(`https://dash.test/api/eve/v1/${path.join("/")}?cursor=next`, { headers: { authorization: "Bearer client", cookie: "untrusted=cookie", "x-trainertwin-user-id": "spoof", "x-trainertwin-org": "spoof-org" } }), { params: Promise.resolve({ path }) });

test.each(["info", "health", "cron", "dev", "session-extra", ""])("Eve proxy rejects non-session path %s with its own notFound and never fetches", async (path) => {
  const response = await call(path ? [path] : []); expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ ok: false, error: "Session not found." });
  expect(upstream).not.toHaveBeenCalled(); expect(lookup).not.toHaveBeenCalled();
});
test("Eve proxy forwards /session/<own id>/stream with server credentials and preserves stream and query", async () => {
  const response = await call(["session", "own-session", "stream"]); expect(response.status).toBe(200);
  expect(await response.text()).toBe("data: hello\n\n"); expect(response.headers.get("content-type")).toBe("text/event-stream"); expect(response.headers.get("set-cookie")).toBeNull();
  expect(lookup).toHaveBeenCalledWith({ where: { sessionId: "own-session" }, select: { orgId: true, userId: true } });
  expect(upstream).toHaveBeenCalledTimes(1);
  const [target, options] = upstream.mock.calls[0]; expect(String(target)).toBe("https://eve.example.com/eve/v1/session/own-session/stream?cursor=next");
  expect(options).toMatchObject({ method: "GET", cache: "no-store", redirect: "manual" });
  const headers = new Headers(options?.headers);
  expect(headers.get("authorization")).toBe(`Basic ${Buffer.from("org:server-secret").toString("base64")}`);
  expect(headers.get("x-trainertwin-user-id")).toBe("trainer");
  expect(headers.has("cookie")).toBe(false); expect(headers.has("x-trainertwin-org")).toBe(false);
});
test.each([{ orgId: "foreign", userId: "trainer" }, { orgId: "org", userId: "foreign" }])("Eve proxy refuses a session owned by $orgId/$userId without fetching", async (foreign) => {
  owner = foreign;
  const response = await call(["session", "foreign", "stream"]); expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ ok: false, error: "Session not found." }); expect(upstream).not.toHaveBeenCalled();
});
