import { expect, mock, test } from "bun:test";

// Client pages load through the page router (lib/pages/router.ts), so its procedures are the page guards now:
// studio pages refuse learners, every member page refuses anonymous callers, and disabled members never get a context.

let memberWhere: unknown = null;
// Next provides `server-only` itself; plain bun has no such package.
mock.module("server-only", () => ({}));
mock.module("next/headers", () => ({ headers: async () => new Headers() }));
mock.module("@/lib/auth", () => ({
  auth: { api: { getSession: async () => ({ user: { id: "u1", name: "U", email: "u@example.com" }, session: { activeOrganizationId: null } }) } },
}));
mock.module("@/lib/db", () => ({
  db: {
    member: {
      findMany: async ({ where }: { where: unknown }) => {
        memberWhere = where;
        return [];
      },
    },
  },
}));

const { pageRouter } = await import("@/lib/pages/router");
const { createTrpcContext } = await import("@/lib/trpc");

type Caller = ReturnType<typeof pageRouter.createCaller>;
const user = (role: string) => ({ id: "u1", name: "U", email: "u@example.com", orgId: "org", orgSlug: "acme", role });
const codeOf = (promise: Promise<unknown>) => promise.then(() => "OK", (error: { code?: string }) => error.code ?? String(error));

const studioOnly: Record<string, (c: Caller) => Promise<unknown>> = {
  ownTwinPersona: (c) => c.ownTwinPersona(),
  twinBrain: (c) => c.twinBrain(),
  agents: (c) => c.agents(),
  rolePlayPreview: (c) => c.rolePlayPreview({ slug: "x" }),
  agentSpec: (c) => c.agentSpec({ slug: "x", isNew: false }),
  calibrationAgent: (c) => c.calibrationAgent({ slug: "x" }),
  fidelity: (c) => c.fidelity(),
  learners: (c) => c.learners(),
  personas: (c) => c.personas(),
  persona: (c) => c.persona({ slug: "x", spec: false }),
  personaEdit: (c) => c.personaEdit({ slug: "x" }),
  sessions: (c) => c.sessions({}),
  session: (c) => c.session({ id: "x" }),
};
const anyMember: Record<string, (c: Caller) => Promise<unknown>> = {
  twinKnowledge: (c) => c.twinKnowledge(),
  talk: (c) => c.talk({}),
  overview: (c) => c.overview(),
  voices: (c) => c.voices(),
  developer: (c) => c.developer(),
  settings: (c) => c.settings(),
};

test("studio pages refuse learners", async () => {
  const learner = pageRouter.createCaller({ user: user("user"), signedIn: true });
  for (const [name, call] of Object.entries(studioOnly)) expect([name, await codeOf(call(learner))]).toEqual([name, "FORBIDDEN"]);
});

test("every studio and member page refuses anonymous callers (sign-in) and org-less users (/auth/no-org)", async () => {
  const anonymous = pageRouter.createCaller({ user: null, signedIn: false });
  const orgless = pageRouter.createCaller({ user: null, signedIn: true });
  for (const [name, call] of Object.entries({ ...studioOnly, ...anyMember })) {
    expect([name, await codeOf(call(anonymous))]).toEqual([name, "UNAUTHORIZED"]);
    expect([name, await codeOf(call(orgless))]).toEqual([name, "FORBIDDEN"]);
  }
});

test("a disabled member gets no tRPC user (signed in, no org)", async () => {
  const ctx = await createTrpcContext({ req: new Request("https://dash.example.test/api/trpc") });
  expect(memberWhere).toEqual({ userId: "u1", disabledAt: null });
  expect(ctx).toMatchObject({ user: null, signedIn: true });
});
