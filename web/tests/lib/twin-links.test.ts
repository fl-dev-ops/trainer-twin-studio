import { expect, mock, test } from "bun:test";

type Agent = { id: string; orgId: string; slug: string; kind: string; personaId: string; data: unknown };
type Persona = { id: string; orgId: string; slug: string; isOwn: boolean };
const personas: Persona[] = [
  { id: "p-olga", orgId: "o1", slug: "olga", isOwn: true },
  { id: "p-gen", orgId: "o1", slug: "generic", isOwn: false },
];
const agents: Agent[] = [
  { id: "main", orgId: "o1", slug: "acme-olga-twin", kind: "TWIN", personaId: "p-olga", data: { source: "twin" } },
  { id: "skill", orgId: "o1", slug: "acme-off-plan", kind: "TWIN", personaId: "p-olga", data: { source: "scenario-ingest" } },
  { id: "clash", orgId: "o1", slug: "acme-olga", kind: "TWIN", personaId: "p-olga", data: { source: "scenario-ingest" } },
  { id: "rp", orgId: "o1", slug: "acme-cold-call", kind: "ROLEPLAY", personaId: "p-gen", data: {} },
  { id: "other", orgId: "o2", slug: "beta-off-plan", kind: "TWIN", personaId: "p-x", data: {} },
];

const slugMatch = (value: string, where: unknown) =>
  typeof where === "string" ? value === where : value.toLowerCase() === String((where as { equals: string }).equals).toLowerCase();

mock.module("@/lib/db", () => ({
  db: {
    persona: {
      findFirst: async ({ where }: { where: { orgId: string; isOwn: boolean; slug: unknown } }) =>
        personas.find((p) => p.orgId === where.orgId && p.isOwn === where.isOwn && slugMatch(p.slug, where.slug)) ?? null,
    },
    agent: {
      findFirst: async ({ where }: { where: Partial<Agent> }) => {
        const agent = agents.find((a) => a.orgId === where.orgId && a.kind === where.kind && (where.id ? a.id === where.id : a.slug === where.slug));
        return agent ? { ...agent, persona: personas.find((p) => p.id === agent.personaId) ?? { slug: "x", isOwn: false } } : null;
      },
      findMany: async ({ where }: { where: Partial<Agent> }) =>
        agents.filter((a) => a.orgId === where.orgId && a.kind === where.kind && a.personaId === where.personaId),
    },
  },
}));

const { resolveTwinPath, shortTwinSlug, twinSharePath } = await import("@/lib/twin-access");

test("short slug drops the org prefix only", () => {
  expect(shortTwinSlug("acme", "acme-off-plan")).toBe("off-plan");
  expect(shortTwinSlug("acme", "off-plan")).toBe("off-plan");
  expect(shortTwinSlug("acme", "acme-")).toBe("acme-");
  expect(shortTwinSlug("acme", "acmeish-plan")).toBe("acmeish-plan");
});

test("/t/<username> opens the trainer's main twin; /t/<slug> a skill twin, short or full", async () => {
  expect(await resolveTwinPath("o1", "acme", "olga")).toEqual({ agentId: "main" });
  expect(await resolveTwinPath("o1", "acme", "Olga")).toEqual({ agentId: "main" });
  expect(await resolveTwinPath("o1", "acme", "off-plan")).toEqual({ agentId: "skill" });
  expect(await resolveTwinPath("o1", "acme", "acme-off-plan")).toEqual({ agentId: "skill" });
});

test("role plays, other orgs' twins and unknown paths open nothing", async () => {
  expect(await resolveTwinPath("o1", "acme", "cold-call")).toBeNull();
  expect(await resolveTwinPath("o1", "acme", "beta-off-plan")).toBeNull();
  expect(await resolveTwinPath("o1", "acme", "nobody")).toBeNull();
  expect(await resolveTwinPath("o1", "acme", "generic")).toBeNull(); // not the trainer's own persona
  expect(await resolveTwinPath("o1", "acme", "")).toBeNull();
});

test("share paths: username for the main twin, short slug for a skill twin unless it is a username", async () => {
  expect(await twinSharePath("o1", "acme", "main")).toBe("olga");
  expect(await twinSharePath("o1", "acme", "skill")).toBe("off-plan");
  // "acme-olga" shortens to "olga", which is the username (it opens the main twin), so the full slug is shared.
  expect(await twinSharePath("o1", "acme", "clash")).toBe("acme-olga");
  expect(await resolveTwinPath("o1", "acme", "acme-olga")).toEqual({ agentId: "clash" });
});
