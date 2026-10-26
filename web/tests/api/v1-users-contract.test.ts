import { expect, mock, test } from "bun:test";

// Public API contract (docs/openapi.yaml, User.role: const member): learners are reported as `member`,
// even though the database stores that role as `user`.

const learner = { id: "u1", name: "Avery", email: "avery@example.com", emailVerified: true };
mock.module("@/lib/auth", () => ({
  auth: { api: { verifyApiKey: async () => ({ valid: true, key: { id: "k1", referenceId: "org1", metadata: null } }) } },
}));
mock.module("@/lib/db", () => ({
  db: {
    organization: { findUnique: async () => ({ id: "org1", slug: "acme", name: "Acme" }) },
    member: {
      // The routes must query learners by the database role.
      findMany: async ({ where }: { where: { role: string } }) =>
        where.role === "user" ? [{ id: "m1", createdAt: new Date(0), user: learner }] : [],
      count: async () => 1,
      findFirst: async ({ where }: { where: { role: string } }) =>
        where.role === "user" ? { id: "m1", createdAt: new Date(0), user: learner } : null,
    },
    invitation: { findMany: async () => [] },
    user: { update: async () => learner },
  },
}));

const { GET: listUsers } = await import("@/app/api/v1/users/route");
const { GET: getUser, PATCH: renameUser } = await import("@/app/api/v1/users/[id]/route");
const request = (method = "GET", body?: unknown) =>
  new Request("https://dash.example.com/api/v1/users", {
    method,
    headers: { "x-api-key": "key", "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
const params = { params: Promise.resolve({ id: "u1" }) };

test("GET /users reports learners with role member", async () => {
  const body = await (await listUsers(request())).json();
  expect(body.users).toEqual([{ ...learner, createdAt: new Date(0).toISOString(), role: "member", memberId: "m1" }]);
});

test("GET /users/:id reports role member", async () => {
  const body = await (await getUser(request(), params)).json();
  expect(body.user).toMatchObject({ id: "u1", memberId: "m1", role: "member" });
});

test("PATCH /users/:id reports role member", async () => {
  const body = await (await renameUser(request("PATCH", { name: "Avery P" }), params)).json();
  expect(body.user).toMatchObject({ id: "u1", memberId: "m1", role: "member" });
});
