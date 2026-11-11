import { expect, mock, test } from "bun:test";

// The userId path must scope membership to the key's org and never fall back to an account lookup.
const memberWheres: unknown[] = [];
const db = {
  member: {
    findFirst: async ({ where }: { where: unknown }) => { memberWheres.push(where); return null; },
  },
  deployment: { findUnique: async () => ({ id: "deployment" }) },
  agent: { findFirst: async () => ({ id: "agent", slug: "acme-rp", name: "RP", data: {} }) },
};
mock.module("@/lib/db", () => ({ db, withLock: async (keys: string[], work: (tx: typeof db) => Promise<unknown>) => {
  expect(keys).toEqual(["people:org1"]); return work(db);
} }));
const externalApi = await import("@/lib/external-api");
mock.module("@/lib/external-api", () => ({
  ...externalApi,
  requireExternalApi: async () => ({ org: { id: "org1", slug: "acme" }, trainer: { userId: "trainer", name: "Trainer" }, actorUserId: "trainer", keyId: "key" }),
}));
const { POST } = await import("@/app/api/v1/assignments/route");

test("refuses not_found for another organization's userId without revealing an account", async () => {
  const response = await POST(new Request("https://test/api/v1/assignments", { method: "POST", body: JSON.stringify({ userId: "foreign-user", scenario: "acme-rp" }) }));
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ code: "not_found", error: "Not found." });
  expect(memberWheres).toEqual([{ organizationId: "org1", userId: "foreign-user" }]);
});
