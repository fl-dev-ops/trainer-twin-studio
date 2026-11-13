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
  withLock: async () => { throw new Error("Unexpected locked write in read-only fixture"); },
  isUniqueViolation: (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "P2002",
  db: {
    member: {
      findMany: async ({ where }: { where: unknown }) => {
        memberWhere = where;
        return [{ role: "user", disabledAt: new Date(), organization: { id: "org", slug: "acme", metadata: null } }];
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
  users: (c) => c.users(),
  personas: (c) => c.personas(),
  persona: (c) => c.persona({ slug: "x", spec: false }),
  personaEdit: (c) => c.personaEdit({ slug: "x" }),
  sessions: (c) => c.sessions({}),
  session: (c) => c.session({ id: "x" }),
  twinKnowledge: (c) => c.twinKnowledge(),
  talk: (c) => c.talk({}),
  overview: (c) => c.overview(),
  voices: (c) => c.voices(),
  developer: (c) => c.developer(),
};
const anyMember: Record<string, (c: Caller) => Promise<unknown>> = { settings: (c) => c.settings() };

test("refuses studio_only on every studio page loader", async () => {
  const learner = pageRouter.createCaller({ user: user("user"), signedIn: true });
  for (const call of Object.values(studioOnly)) await expect(call(learner)).rejects.toMatchObject({ code: "FORBIDDEN", message: "Only the organization's admin and team can do this.", cause: { code: "studio_only", status: 403 } });
});

test("refuses signed_out and no_org with exact page-loader statuses/messages", async () => {
  const anonymous = pageRouter.createCaller({ user: null, signedIn: false });
  const orgless = pageRouter.createCaller({ user: null, signedIn: true });
  for (const [name, call] of Object.entries({ ...studioOnly, ...anyMember })) {
    await expect(call(anonymous)).rejects.toMatchObject({ code: "UNAUTHORIZED", message: "Sign in first.", cause: { code: "signed_out", status: 401 } });
    await expect(call(orgless)).rejects.toMatchObject({ code: "FORBIDDEN", message: "You're not a member of this organization.", cause: { code: "no_org", status: 403 } });
  }
});

test("refuses member_disabled in the server page context despite cached signed-in identity", async () => {
  const ctx = await createTrpcContext({ req: new Request("https://dash.example.test/api/trpc") });
  expect(memberWhere).toEqual({ userId: "u1" });
  expect(ctx).toMatchObject({ user: null, signedIn: true, refusal: { code: "member_disabled", status: 403, message: "Your access to this organization has been turned off. Ask its admin to turn it back on." } });
});
