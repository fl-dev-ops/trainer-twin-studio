import { expect, mock, test } from "bun:test";

// Calibrations are for studio members (admin, team) only: checked at the page (requireStudioMember)
// and at the API (studioProcedure on every calibrations.* procedure).

let role: string | null = "user";
mock.module("next/headers", () => ({ headers: async () => new Headers() }));
mock.module("@/lib/auth", () => ({
  auth: { api: { getSession: async () => (role === null ? null : { user: { id: "u1", name: "U", email: "u@example.com" } }) } },
}));
mock.module("@/lib/db", () => ({
  db: {
    member: {
      findFirst: async () => (role === null ? null : { role, organization: { id: "org", slug: "acme", metadata: null } }),
    },
    // Reached only when a studio member gets past the guards.
    twinCalibration: { findFirst: async () => null },
  },
}));

const { requireStudioMember } = await import("@/lib/org");
const { twinRouter } = await import("@/lib/twin/trpc");

const caller = (who: string | null) =>
  twinRouter.createCaller({ user: who === null ? null : { id: "u1", name: "U", email: "u@example.com", orgId: "org", orgSlug: "acme", role: who } });
const codeOf = (promise: Promise<unknown>) => promise.then(() => "OK", (error: { code?: string }) => error.code ?? String(error));

const calls = {
  list: (c: ReturnType<typeof caller>) => c.calibrations.list({ slug: "acme-twin" }),
  get: (c: ReturnType<typeof caller>) => c.calibrations.get({ id: "cal" }),
  start: (c: ReturnType<typeof caller>) => c.calibrations.start({ slug: "acme-twin", sessionId: "s1" }),
  rate: (c: ReturnType<typeof caller>) => c.calibrations.rate({ calibrationId: "cal", turnIndex: 1, question: null, reply: "x", rating: "like" }),
};

test("API: learners (user role) are refused every calibration procedure", async () => {
  for (const [name, call] of Object.entries(calls)) expect([name, await codeOf(call(caller("user")))]).toEqual([name, "FORBIDDEN"]);
});

test("API: anonymous callers are refused", async () => {
  for (const [name, call] of Object.entries(calls)) expect([name, await codeOf(call(caller(null)))]).toEqual([name, "UNAUTHORIZED"]);
});

test("API: admin and team get past the guard (then hit the data: not found here)", async () => {
  for (const who of ["admin", "team"]) expect(await codeOf(calls.get(caller(who)))).toBe("NOT_FOUND");
});

const redirectOf = (promise: Promise<unknown>) =>
  promise.then(() => null, (error: { digest?: string }) => error.digest?.split(";").find((part) => part.startsWith("/")) ?? String(error));

test("page: learners and people outside an org are sent to the learner landing page", async () => {
  role = "user";
  expect(await redirectOf(requireStudioMember())).toBe("/auth/no-org");
  role = null;
  expect(await redirectOf(requireStudioMember())).toBe("/auth/no-org");
});

test("page: admin and team are let in", async () => {
  for (const who of ["admin", "team"]) {
    role = who;
    expect(await requireStudioMember()).toMatchObject({ id: "org", slug: "acme", role: who });
  }
});
