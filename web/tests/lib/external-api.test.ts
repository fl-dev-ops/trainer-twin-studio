import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";

type Verification = { valid: boolean; key: { id: string; referenceId: string; metadata: { createdByUserId: string } | null } | null; error?: { code: string; details?: { tryAgainIn: number } } };
const verified: Verification = { valid: true, key: { id: "key", referenceId: "org", metadata: { createdByUserId: "trainer" } } };
let verification: Verification;
let orgExists = true;
let ownerExists = true;
const verifyApiKey = mock(async (_input: unknown) => verification);
const owners = mock(async (_input: unknown) => ownerExists ? [{ id: "member", role: "team", disabledAt: null, createdAt: new Date(0), user: { id: "trainer", name: "Trainer", email: "trainer@example.com", image: null } }] : []);
mock.module("@/lib/auth", () => ({ auth: { api: { verifyApiKey } } }));
mock.module("@/lib/db", () => ({
  withLock: async () => { throw new Error("Unexpected write in authentication fixture"); },
  isUniqueViolation: () => false,
  db: {
    organization: { findUnique: async () => orgExists ? { id: "org", slug: "acme", name: "Acme" } : null },
    member: { findMany: owners },
  },
}));
const { apiRoute, requireExternalApi, paginationFromUrl, externalApiKey } = await import("@/lib/external-api");
const request = (headers: HeadersInit = { "x-api-key": "key" }) => new Request("https://test/api/v1/users", { headers });
const handle = apiRoute(async (req) => { const api = await requireExternalApi(req, "users", "write"); return Response.json({ actor: api.actorUserId }); });
beforeEach(() => { verification = verified; orgExists = ownerExists = true; verifyApiKey.mockClear(); owners.mockClear(); });
afterEach(() => mock.restore());

const invalidCodes = ["INVALID_API_KEY", "KEY_DISABLED", "KEY_EXPIRED", "RATE_LIMIT_EXCEEDED", "UNKNOWN_PLUGIN_CODE"];
test.each(invalidCodes)("refuses api_key_invalid for plugin %s (the old RATE_LIMIT_EXCEEDED is not a rate limit)", async (code) => {
  verification = { valid: false, key: null, error: { code } };
  await expect(requireExternalApi(request(), "users", "write")).rejects.toMatchObject({ code: "api_key_invalid", status: 401, message: "Send a valid API key." });
  const response = await handle(request());
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ code: "api_key_invalid", error: "Send a valid API key." });
  expect(response.headers.get("Retry-After")).toBeNull();
});
test("refuses api_key_invalid without a key, without a verified key, or when its org is gone", async () => {
  expect((await handle(request({}))).status).toBe(401); expect(verifyApiKey).not.toHaveBeenCalled();
  verification = { valid: true, key: null };
  expect((await handle(request())).status).toBe(401);
  verification = verified; orgExists = false;
  const response = await handle(request()); expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ code: "api_key_invalid", error: "Send a valid API key." });
});
test("refuses scope_missing for KEY_NOT_FOUND with the requested action and resource", async () => {
  verification = { valid: false, key: null, error: { code: "KEY_NOT_FOUND" } };
  const response = await handle(request()); expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ code: "scope_missing", error: "This API key can't write users." });
  expect(verifyApiKey).toHaveBeenCalledWith({ body: { key: "key", permissions: { users: ["write"] } } });
});
test.each(["RATE_LIMITED", "USAGE_EXCEEDED"])("refuses rate_limited for %s: 1500 ms rounds up to Retry-After 2 and message {n}", async (code) => {
  verification = { valid: false, key: null, error: { code, details: { tryAgainIn: 1500 } } };
  const response = await handle(request()); expect(response.status).toBe(429);
  expect(response.headers.get("Retry-After")).toBe("2");
  expect(await response.json()).toEqual({ code: "rate_limited", error: "Too many requests. Try again in 2 seconds." });
});
test.each([{ ms: undefined, seconds: 60 }, { ms: 0, seconds: 1 }, { ms: -1000, seconds: 1 }, { ms: 1001, seconds: 2 }])("rate limit default and minimum ($ms ms)", async ({ ms, seconds }) => {
  verification = { valid: false, key: null, error: { code: "RATE_LIMITED", ...(ms === undefined ? {} : { details: { tryAgainIn: ms } }) } };
  const response = await handle(request()); expect(response.status).toBe(429); expect(response.headers.get("Retry-After")).toBe(String(seconds));
  expect(await response.json()).toEqual({ code: "rate_limited", error: `Too many requests. Try again in ${seconds} seconds.` });
});
test("refuses internal_error for FAILED_TO_UPDATE_API_KEY", async () => {
  verification = { valid: false, key: null, error: { code: "FAILED_TO_UPDATE_API_KEY" } };
  const response = await handle(request()); expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ code: "internal_error", error: "Something went wrong. Try again." });
});
test("refuses internal_error for a plain Error and logs the method, path and original error", async () => {
  const failure = new Error("private database details");
  const log = spyOn(console, "error").mockImplementation(() => {});
  const response = await apiRoute(async () => { throw failure; })(request());
  expect(response.status).toBe(500); expect(response.headers.get("Retry-After")).toBeNull();
  expect(await response.json()).toEqual({ code: "internal_error", error: "Something went wrong. Try again." });
  expect(log).toHaveBeenCalledWith("[api] GET /api/v1/users failed:", failure);
});
test.each(["missing metadata", "owner gone"])("refuses api_key_owner_gone for %s", async (kind) => {
  if (kind === "missing metadata") verification = { ...verified, key: { ...verified.key!, metadata: null } };
  else ownerExists = false;
  const response = await handle(request()); expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ code: "api_key_owner_gone", error: "This API key's owner is no longer on the team. Create a new key." });
});
test("valid key acts as its enabled studio creator and filters the owner by id and studio roles", async () => {
  expect(await (await handle(request())).json()).toEqual({ actor: "trainer" });
  expect(owners).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: "org", role: { in: ["admin", "team"] }, userId: { in: ["trainer"] }, disabledAt: null } }));
});
test("API key header and Bearer extraction trim values and prefer x-api-key", () => {
  expect(externalApiKey(request({ "x-api-key": " header ", authorization: "Bearer token" }))).toBe("header");
  expect(externalApiKey(request({ authorization: "bearer token " }))).toBe("token");
  expect(externalApiKey(request({ authorization: "Basic token" }))).toBeNull();
});
test.each(["limit=0", "limit=101", "limit=1.5", "limit=bad", "limit=", "limit=1e2", "offset=-1", "offset=0.5", "offset=bad", "offset=", "offset=2147483648", "offset=9007199254740992"])("pagination throws invalid_input for %s; apiRoute returns a coded 400", async (query) => {
  const url = new URL(`https://test/api/v1/users?${query}`);
  expect(() => paginationFromUrl(url)).toThrow(expect.objectContaining({ code: "invalid_input", status: 400 }));
  const response = await apiRoute(async () => Response.json(paginationFromUrl(url)))(request());
  expect(response.status).toBe(400); expect(await response.json()).toEqual({ code: "invalid_input", error: "limit must be 1–100 and offset 0 or more." });
});
test("pagination defaults and valid boundaries return values, not Responses", () => {
  expect(paginationFromUrl(new URL("https://test"))).toEqual({ limit: 50, offset: 0 });
  expect(paginationFromUrl(new URL("https://test?limit=1&offset=0"))).toEqual({ limit: 1, offset: 0 });
  expect(paginationFromUrl(new URL("https://test?limit=100&offset=999"))).toEqual({ limit: 100, offset: 999 });
});
test("a coded API refusal satisfies the published OpenAPI Error required/properties/additionalProperties contract", async () => {
  const spec = load(readFileSync(new URL("../../../docs/openapi.yaml", import.meta.url), "utf8")) as { components: { schemas: { Error: { type: string; required: string[]; properties: Record<string, { type: string }>; additionalProperties: boolean } } } };
  const schema = spec.components.schemas.Error;
  const body: Record<string, unknown> = await (await handle(request({}))).json();
  expect(schema.type).toBe("object"); expect(schema.required).toEqual(["error", "code"]); expect(schema.additionalProperties).toBe(false);
  expect(schema.properties.code.type).toBe("string");
  for (const field of schema.required) expect(Object.hasOwn(body, field)).toBe(true);
  for (const [field, value] of Object.entries(body)) { expect(schema.properties[field]).toBeDefined(); expect(typeof value).toBe(schema.properties[field].type); }
});
test("every v1 resource method exports apiRoute(handleX), except the model-call route", () => {
  const root = join(import.meta.dir, "../../app/api/v1");
  const routes = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? routes(join(dir, entry.name)) : entry.name === "route.ts" ? [join(dir, entry.name)] : []);
  const resources = routes(root).filter((file) => !file.includes("/chat/")); expect(resources).toHaveLength(10);
  for (const file of resources) {
    const source = readFileSync(file, "utf8");
    const methods = [...source.matchAll(/export const (GET|POST|PATCH|DELETE) = (.+);/g)]; expect(methods.length).toBeGreaterThan(0);
    for (const [, method, expression] of methods) expect(expression).toBe(`apiRoute(handle${method})`);
    expect(source).not.toMatch(/export (?:async )?function (?:GET|POST|PATCH|DELETE)\b/);
  }
});
