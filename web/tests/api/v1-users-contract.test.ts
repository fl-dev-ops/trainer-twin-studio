import { expect, mock, test } from "bun:test";

// Public API contract (docs/openapi.yaml, User.role: const member): learners are reported as `member`,
// even though the database stores that role as `user`.

const learner = { id: "u1", name: "Avery", email: "avery@example.com", emailVerified: true };
mock.module("@/lib/auth", () => ({
  auth: { api: { verifyApiKey: async () => ({ valid: true, key: { id: "k1", referenceId: "org1", metadata: { createdByUserId: "t1" } } }) } },
}));
mock.module("@/lib/db", () => ({
  withLock: async () => { throw new Error("Unexpected locked write in read-only fixture"); },
  isUniqueViolation: (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "P2002",
  db: {
    $queryRaw: async () => [],
    organization: { findUnique: async () => ({ id: "org1", slug: "acme", name: "Acme" }) },
    member: {
      // The routes must query learners by the database role.
      findMany: async ({ where }: { where: { role: { in: string[] } } }) =>
        where.role.in.includes("user") ? [{ id: "m1", role: "user", disabledAt: null, createdAt: new Date(0), user: { ...learner, image: null } }] : [{ id: "trainer-member", role: "team", disabledAt: null, createdAt: new Date(0), user: { id: "t1", name: "Trainer", email: "trainer@acme.com", image: null } }],
      count: async () => 0,
      findFirst: async ({ where }: { where: { userId: string } }) =>
        where.userId === "u1" ? { id: "m1", role: "user", disabledAt: null, createdAt: new Date(0), user: { ...learner, image: null } } : null,
    },
    invitation: { findMany: async () => [] },
    user: { update: async () => learner, findMany: async () => [learner], findUnique: async () => learner, findUniqueOrThrow: async () => learner },
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
  expect(body.users).toEqual([{ ...learner, createdAt: new Date(0).toISOString(), role: "member", memberId: "m1", creditsGiven: 0, creditsLeft: 0 }]);
});

test("GET /users/:id reports role member", async () => {
  const body = await (await getUser(request(), params)).json();
  expect(body.user).toMatchObject({ id: "u1", memberId: "m1", role: "member" });
});

test("PATCH /users/:id reports role member", async () => {
  const body = await (await renameUser(request("PATCH", { name: "Avery P" }), params)).json();
  expect(body.user).toMatchObject({ id: "u1", memberId: "m1", role: "member" });
});
