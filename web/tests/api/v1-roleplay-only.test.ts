import { beforeEach, expect, mock, test } from "bun:test";

// The public API (/api/v1) serves role plays only: twins are not listed, not startable and their sessions are
// not visible. A twin answers exactly like an unknown scenario, deployment key or session.

type Where = Record<string, unknown>;
const seen: Record<string, Where[]> = {};
const record = (name: string, where: Where) => ((seen[name] ??= []).push(where), where);
let activations: Record<string, unknown>[] = [];

const isRoleplay = (where: Where) => where.kind === "ROLEPLAY" || (where.agent as Where | undefined)?.kind === "ROLEPLAY";
mock.module("@/lib/auth", () => ({
  auth: { api: { verifyApiKey: async () => ({ valid: true, key: { id: "k1", referenceId: "org1", metadata: null } }) } },
}));
mock.module("@/lib/db", () => ({
  db: {
    organization: { findUnique: async () => ({ id: "org1", slug: "acme", name: "Acme" }) },
    agent: {
      findMany: async ({ where }: { where: Where }) => (record("agent.findMany", where), []),
      count: async ({ where }: { where: Where }) => (record("agent.count", where), 0),
      // acme-twin is a TWIN, acme-rp a ROLEPLAY
      findFirst: async ({ where }: { where: Where }) => {
        record("agent.findFirst", where);
        if (where.slug === "acme-twin") return where.kind === "TWIN" ? { id: "a-twin" } : null;
        if (where.slug === "acme-rp" && where.kind !== "TWIN") return { id: "a-rp", slug: "acme-rp", deployments: [] };
        return null;
      },
    },
    deployment: {
      findFirst: async ({ where }: { where: Where }) =>
        where.publicKey === "twin-key" && (where.agent as Where)?.kind === "TWIN" ? { id: "d-twin" } : null,
    },
    user: { findFirst: async () => ({ id: "u1", name: "Avery", email: "avery@example.com" }) },
    interviewSession: {
      findMany: async ({ where }: { where: Where }) => (record("session.findMany", where), []),
      count: async ({ where }: { where: Where }) => (record("session.count", where), 0),
      findFirst: async ({ where }: { where: Where }) => (record("session.findFirst", where), where.id === "s-twin" && !isRoleplay(where) ? { id: "s-twin" } : null),
      updateMany: async ({ where }: { where: Where }) => (record("session.updateMany", where), { count: isRoleplay(where) ? 0 : 1 }),
    },
  },
}));
mock.module("@/lib/session-activation", () => ({
  activateInterviewRuntime: async (input: Record<string, unknown>) => {
    activations.push(input);
    if (!input.deploymentKey && !input.agentSlug) throw new Error("Agent is required");
    return { session: { id: "s1" } };
  },
}));

const { GET: listScenarios } = await import("@/app/api/v1/scenarios/route");
const { GET: getScenario } = await import("@/app/api/v1/scenarios/[slug]/route");
const { GET: listSessions, POST: startSession } = await import("@/app/api/v1/sessions/route");
const { GET: getSession, DELETE: deleteSession } = await import("@/app/api/v1/sessions/[id]/route");

const call = (url: string, method = "GET", body?: unknown) =>
  new Request(`https://dash.example.com/api/v1${url}`, {
    method,
    headers: { "x-api-key": "key", "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });

beforeEach(() => {
  for (const key of Object.keys(seen)) delete seen[key];
  activations = [];
});

test("GET /scenarios lists and counts role plays only", async () => {
  expect((await listScenarios(call("/scenarios"))).status).toBe(200);
  expect(seen["agent.findMany"]).toEqual([{ orgId: "org1", kind: "ROLEPLAY" }]);
  expect(seen["agent.count"]).toEqual([{ orgId: "org1", kind: "ROLEPLAY" }]);
});

test("GET /scenarios/:slug answers 404 for a twin, like an unknown scenario", async () => {
  const twin = await getScenario(call("/scenarios/acme-twin"), { params: Promise.resolve({ slug: "acme-twin" }) });
  expect(twin.status).toBe(404);
  expect(await twin.json()).toEqual({ error: "Scenario not found" });
  expect(seen["agent.findFirst"]).toEqual([{ orgId: "org1", slug: "acme-twin", kind: "ROLEPLAY" }]);
});

test("POST /sessions: a twin scenario is refused like an unknown one and nothing starts", async () => {
  const response = await startSession(call("/sessions", "POST", { userId: "u1", scenario: "acme-twin" }));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "Agent not found" });
  expect(activations).toEqual([]);
});

test("POST /sessions: role plays start as before", async () => {
  const response = await startSession(call("/sessions", "POST", { userId: "u1", scenario: "acme-rp" }));
  expect(response.status).toBe(201);
  expect(activations).toEqual([expect.objectContaining({ agentSlug: "acme-rp", mode: "chat", userEmail: "avery@example.com" })]);
});

test("POST /sessions: a twin's deployment key is ignored, like an unknown key", async () => {
  const response = await startSession(call("/sessions", "POST", { userId: "u1", deploymentKey: "twin-key" }));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "Agent is required" });
  expect(activations).toEqual([expect.objectContaining({ deploymentKey: undefined })]);
});

test("GET /sessions only returns role-play sessions", async () => {
  expect((await listSessions(call("/sessions"))).status).toBe(200);
  expect(seen["session.findMany"]?.[0]).toMatchObject({ orgId: "org1", agent: { kind: "ROLEPLAY" } });
  expect(seen["session.count"]?.[0]).toMatchObject({ agent: { kind: "ROLEPLAY" } });
});

test("GET and DELETE /sessions/:id answer 404 for a twin session", async () => {
  const params = { params: Promise.resolve({ id: "s-twin" }) };
  expect((await getSession(call("/sessions/s-twin"), params)).status).toBe(404);
  expect((await deleteSession(call("/sessions/s-twin", "DELETE"), params)).status).toBe(404);
  expect(seen["session.findFirst"]?.[0]).toMatchObject({ agent: { kind: "ROLEPLAY" } });
  expect(seen["session.updateMany"]?.[0]).toMatchObject({ agent: { kind: "ROLEPLAY" } });
});
