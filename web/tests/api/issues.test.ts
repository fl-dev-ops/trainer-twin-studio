import { beforeEach, expect, mock, test } from "bun:test";

const headers = new Headers({ host: "dash.test" });
const create = mock(async (_args: unknown) => ({ id: "issue" }));
const after = mock((_fn: unknown) => {});
mock.module("next/headers", () => ({ headers: async () => headers }));
const realNext = await import("next/server");
mock.module("next/server", () => ({ ...realNext, after }));
const realAuth = await import("@/lib/auth");
mock.module("@/lib/auth", () => ({ ...realAuth, auth: { api: { getSession: async () => ({ user: { id: "learner", name: "Learner", email: "learner@example.com" } }) } } }));
const realOrg = await import("@/lib/org");
mock.module("@/lib/org", () => ({ ...realOrg, getOrgBySlug: async () => null, getSessionOrg: async () => ({ id: "org" }) }));
mock.module("@/lib/db", () => ({ db: { issueReport: { create } } }));
const { POST } = await import("@/app/api/issues/route");
const request = (url: string) => new Request("https://test/api/issues", { method: "POST", body: JSON.stringify({ message: "The call stopped", url }) });
beforeEach(() => { create.mockClear(); after.mockClear(); });

test.each(["https://example.com/call", "http://example.com/call"])("issue reports accept web links %s", async (url) => {
  expect((await POST(request(url))).status).toBe(201);
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ url }) }));
  expect(after).toHaveBeenCalledTimes(1);
});
test.each(["javascript:alert(1)", "data:text/html,hello", "ftp://example.com"])("issue URL %s must return 400 for invalid input, actual 422", async (url) => {
  const response = await POST(request(url));
  expect(create).not.toHaveBeenCalled(); expect(after).not.toHaveBeenCalled();
  expect(response.status).toBe(400);
});
