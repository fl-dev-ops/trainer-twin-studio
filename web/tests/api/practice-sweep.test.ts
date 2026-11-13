import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { cronAuthorized } from "@/lib/cron";
const sweep = mock(async () => 3);
mock.module("@/lib/session-lifecycle", () => ({ sweepStaleCalls: sweep }));
const { GET, POST } = await import("@/app/api/internal/sessions/sweep/route");
const keys = ["CRON_SECRET", "INTERNAL_API_SECRET", "VERCEL"] as const;
let previous: (string | undefined)[];
beforeEach(() => { previous = keys.map((key) => process.env[key]); for (const key of keys) delete process.env[key]; sweep.mockClear(); });
afterEach(() => { keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; }); });
const request = (headers: HeadersInit = {}) => new Request("https://test/api/internal/sessions/sweep", { headers });

test.each(["GET", "POST"] as const)("refuses signed_out for unauthorized cron %s without running the sweep", async (method) => {
  process.env.CRON_SECRET = "secret";
  const response = await (method === "GET" ? GET : POST)(request({ authorization: "Bearer wrong" }));
  expect(response.status).toBe(401); expect(await response.json()).toEqual({ code: "signed_out", error: "Sign in first." });
  expect(sweep).not.toHaveBeenCalled();
});
test("authorized cron runs the sweep and returns its count, every five minutes", async () => {
  process.env.CRON_SECRET = "secret";
  for (const headers of [{ authorization: "Bearer secret" }, { "x-internal-secret": "secret" }]) {
    const response = await GET(request(headers)); expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true, ended: 3 });
  }
  expect(sweep).toHaveBeenCalledTimes(2);
  const config = JSON.parse(readFileSync(new URL("../../vercel.json", import.meta.url), "utf8")) as { crons: { path: string; schedule: string }[] };
  expect(config.crons).toContainEqual({ path: "/api/internal/sessions/sweep", schedule: "*/5 * * * *" });
});
test("cron authorization fails closed on Vercel without a secret, allows local dev, and supports the internal fallback", () => {
  expect(cronAuthorized(request())).toBe(true);
  process.env.VERCEL = "1"; expect(cronAuthorized(request())).toBe(false);
  process.env.INTERNAL_API_SECRET = "fallback";
  expect(cronAuthorized(request({ "x-internal-secret": "fallback" }))).toBe(true);
  expect(cronAuthorized(request({ authorization: "Bearer fallback" }))).toBe(true);
  process.env.CRON_SECRET = "primary";
  expect(cronAuthorized(request({ "x-internal-secret": "fallback" }))).toBe(false);
});
test("cron with wrong non-ASCII token must refuse, not throw", () => {
  process.env.CRON_SECRET = "ab";
  expect(cronAuthorized(request({ authorization: "Bearer éé" }))).toBe(false);
});
