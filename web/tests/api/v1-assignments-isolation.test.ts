import { expect, mock, test } from "bun:test";

// docs/limits.mdx, organization isolation: a user of another organization answers like an unknown one. Assignments
// used to look learners up by ID across every organization, so a key could assign (and read the email of) anyone.

const memberWheres: Record<string, unknown>[] = [];
mock.module("@/lib/auth", () => ({
  auth: { api: { verifyApiKey: async () => ({ valid: true, key: { id: "k1", referenceId: "org1", metadata: null } }) } },
}));
mock.module("@/lib/db", () => ({
  db: {
    organization: { findUnique: async () => ({ id: "org1", slug: "acme", name: "Acme" }) },
    // Only org1's learner u1 exists in org1; u2 is a learner of another organization.
    member: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        memberWheres.push(where);
        if (where.role === "user") return where.organizationId === "org1" && where.userId === "u1" ? { user: { id: "u1", name: "Avery", email: "avery@acme.com" } } : null;
        return { userId: "t1", user: { name: "Trainer" } };
      },
    },
    user: { findUnique: async () => ({ id: "u2", name: "Other", email: "other@elsewhere.com" }) },
    agent: { findFirst: async () => ({ id: "a1", slug: "acme-rp", name: "RP", data: {} }) },
  },
}));

const { POST } = await import("@/app/api/v1/assignments/route");
const create = (body: unknown) =>
  POST(new Request("https://dash.example.com/api/v1/assignments", {
    method: "POST",
    headers: { "x-api-key": "key", "content-type": "application/json" },
    body: JSON.stringify(body),
  }));

test("POST /assignments with another organization's user ID answers 404 and reveals nothing", async () => {
  const response = await create({ userId: "u2", scenario: "acme-rp" });
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "User not found" });
  expect(memberWheres[0]).toMatchObject({ organizationId: "org1", userId: "u2", role: "user", disabledAt: null });
});
