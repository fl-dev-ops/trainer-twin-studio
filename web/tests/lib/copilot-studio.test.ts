import { beforeEach, expect, test } from "bun:test";
import * as people from "@/lib/org-people";
import { type CopilotStudioDeps, runCopilotStudio } from "@/lib/copilot-studio";
import { skillPackageHash, type SkillFormat } from "@/lib/skills";
import { renderRoleplay } from "@/lib/roleplay/skill";

type Row = Record<string, unknown>;
let agents: Row[] = [];
const invited: { kind: string; emails: string[] }[] = [];
let delivery = { emailFailures: 0 } as { emailFailures: number; emailsQueued?: number; emailProgress?: string };
const s3 = new Map<string, string>();
let packages: Row[] = [];
let mappings: { orgId: string; agentId: string; agentVersion: number; skillVersionId: string; createdAt: Date }[] = [];

const matches = (agent: Row, where: Row) => Object.entries(where).every(([key, value]) => {
  if (key === "archivedAt") return value === null ? agent.archivedAt == null : agent.archivedAt != null;
  return agent[key] === value;
});

const fakeDb = {
  agent: {
    findFirst: async ({ where }: { where: Row }) => agents.find((agent) => matches(agent, where)) ?? null,
    findMany: async ({ where }: { where: Row }) => agents.filter((agent) => matches(agent, where)),
    update: async ({ where, data }: { where: { id: string }; data: Row }) => Object.assign(agents.find((agent) => agent.id === where.id)!, data),
  },
  member: {
    // Olga's org: admin@ is a studio member, learner@ a learner.
    findMany: async () => [
      { role: "admin", user: { email: "admin@olga.com" } },
      { role: "user", user: { email: "learner@olga.com" } },
    ],
  },
  specVersion: {
    findFirst: async ({ where }: { where: { version: number } }) => (where.version === 1 ? { data: { skill: "# v1", artifacts: "art/v1" } } : null),
    findMany: async () => [{ version: 1, createdAt: new Date("2026-10-28") }],
  },
  skillVersion: {
    findFirst: async ({ where }: { where: Row }) => packages.find((row) =>
      row.id === where.id && row.status === where.status && matches(row.skill as Row, where.skill as Row)) ?? null,
    findMany: async ({ where }: { where: Row }) => packages.filter((row) =>
      row.skillId === where.skillId && row.artifacts === where.artifacts && row.status === where.status &&
      matches(row.skill as Row, where.skill as Row)),
  },
  agentSkillVersion: {
    findFirst: async ({ where }: { where: { orgId: string; agentId: string; agentVersion: number } }) => {
      const mapping = mappings.find((row) => row.orgId === where.orgId && row.agentId === where.agentId && row.agentVersion === where.agentVersion);
      const agent = agents.find((row) => row.id === where.agentId && row.orgId === where.orgId);
      if (!mapping || !agent) return null;
      return { ...mapping, agent, version: packages.find((row) => row.id === mapping.skillVersionId) };
    },
    findMany: async ({ where }: { where: { orgId: string; agentId: string; version: { skill: Row } } }) => mappings.filter((row) =>
      row.orgId === where.orgId && row.agentId === where.agentId &&
      packages.some((pkg) => pkg.id === row.skillVersionId && matches(pkg.skill as Row, where.version.skill))),
  },
  rolePlayAssignment: { findMany: async () => [] },
  knowledgeDocument: { findMany: async () => [] },
};
const checkPeople = (emails: string[]) => {
  if (emails.includes("admin@olga.com")) throw people.peopleRefusals.personIsStudio(["admin@olga.com"]);
};
const deps = {
  db: fakeDb,
  getObjectText: async (key: string) => {
    if (!s3.has(key)) throw new Error("missing");
    return s3.get(key)!;
  },
  listTwinAssignments: async () => [],
  assignTwinAndInvite: async (input: { emails: string[] }) => {
    checkPeople(input.emails);
    invited.push({ kind: "twin", emails: input.emails });
    return { stats: { added: input.emails.length }, ...delivery };
  },
  inviteToRoleplay: async (input: { emails: string[] }) => {
    checkPeople(input.emails);
    invited.push({ kind: "roleplay", emails: input.emails });
    return { added: input.emails.length, ...delivery };
  },
  updateTwin: async () => ({ version: 2, changed: true }),
  updateRoleplay: async () => ({ changed: true }),
} as unknown as CopilotStudioDeps;

// Real modules, injected fakes: nothing is stubbed process-wide, so other test files are unaffected.
const run = (input: Parameters<typeof runCopilotStudio>[1]) => runCopilotStudio(actor, input, deps);
const actor = { org: { id: "org1", slug: "olga" }, user: { id: "u1", name: "Olga" } };

beforeEach(() => {
  delivery = { emailFailures: 0 };
  invited.length = 0;
  s3.clear();
  packages = [];
  mappings = [];
  agents = [
    { id: "a1", orgId: "org1", slug: "olga-olga-twin", name: "Olga's twin", kind: "TWIN", version: 5, data: { source: "twin" }, archivedAt: null, updatedAt: new Date() },
    { id: "a2", orgId: "org1", slug: "olga-objection-handling", name: "Objection Handling", kind: "TWIN", version: 2, data: { source: "twin-creator", skill: "# v2", artifacts: "art/v2", scenario: { skill: "objection-handling" } }, archivedAt: null, updatedAt: new Date() },
    { id: "a3", orgId: "org1", slug: "olga-old-skill", name: "Old", kind: "TWIN", version: 1, data: { source: "twin-creator" }, archivedAt: new Date(), updatedAt: new Date() },
  ];
});

test.each(["twin", "roleplay"] as const)("refuses person_is_studio for the whole copilot %s batch without pre-filtering", async (kind) => {
  agents[1].kind = kind === "twin" ? "TWIN" : "ROLEPLAY";
  await expect(run({ action: "inviteLearners", kind, slug: "olga-objection-handling", emails: ["admin@olga.com", "learner@olga.com", "new@x.com"] })).rejects.toMatchObject({ code: "person_is_studio", status: 409 });
  expect(invited).toEqual([]);
});

test("an invite of only studio members sends nothing", async () => {
  await expect(run({ action: "inviteLearners", slug: "olga-objection-handling", emails: ["admin@olga.com"] })).rejects.toMatchObject({ code: "person_is_studio", status: 409 });
  expect(invited).toEqual([]);
});

test("twin invites take no minutes: new learners get their starting minutes from the org balance", async () => {
  const result = await run({ action: "inviteLearners", slug: "olga-objection-handling", emails: ["new@x.com"] });
  expect(result).toMatchObject({ stats: { added: 1 } });
  expect(result).not.toHaveProperty("refused");
});

test("archive is soft and restorable; the main twin can't be archived", async () => {
  await run({ action: "archive", slug: "olga-objection-handling" });
  expect(agents[1].archivedAt).toBeInstanceOf(Date);
  expect((await run({ action: "list" }) as { items: { slug: string }[] }).items.map((i) => i.slug)).not.toContain("olga-objection-handling");
  await run({ action: "restore", slug: "olga-objection-handling" });
  expect(agents[1].archivedAt).toBeNull();
  await expect(run({ action: "archive", slug: "olga-olga-twin" })).rejects.toThrow(/main twin/);
});

test("archived items are listed only on request, and can't be invited to", async () => {
  const all = await run({ action: "list", includeArchived: true }) as { items: { slug: string; archived: boolean }[] };
  expect(all.items.find((i) => i.slug === "olga-old-skill")?.archived).toBe(true);
  await expect(run({ action: "inviteLearners", slug: "olga-old-skill", emails: ["new@x.com"], minutes: 10 })).rejects.toThrow(/not found/);
});

test("getSkill reads the version's own S3 copy (current or older)", async () => {
  s3.set("art/v2/items.json", JSON.stringify([{ id: "i1" }]));
  s3.set("art/v2/skill.json", JSON.stringify({ skill: "objection-handling" }));
  const current = await run({ action: "getSkill", slug: "olga-objection-handling" }) as Row;
  expect(current).toMatchObject({ version: 2, skill: "# v2", items: [{ id: "i1" }], manifest: { skill: "objection-handling" } });
  s3.set("art/v1/items.json", JSON.stringify([{ id: "old" }]));
  const older = await run({ action: "getSkill", slug: "olga-objection-handling", version: 1 }) as Row;
  expect(older).toMatchObject({ version: 1, skill: "# v1", items: [{ id: "old" }] });
});

const managedPackage = (format: SkillFormat = "twin", artifacts = "art/v2") => {
  const manifest = format === "twin" ? { skill: "objection-handling" } : { scenario: "objection-handling" };
  const files = {
    "SKILL.md": "# Managed instructions",
    [format === "twin" ? "skill.json" : "scenario.json"]: JSON.stringify(manifest),
    "items.json": JSON.stringify([{ id: "managed" }]),
    "patterns.md": "Managed patterns",
  };
  return {
    id: `managed-${artifacts}`,
    skillId: "managed-skill", artifacts, status: "ready", indexStatus: "failed",
    skill: { orgId: "org1", ownerSlug: "olga-objection-handling" },
    format, files, manifest, skillText: files["SKILL.md"], itemCount: 1, contentHash: skillPackageHash(format, files),
  };
};

const mapPackage = (version: number, pkg: ReturnType<typeof managedPackage>) => {
  packages.push(pkg);
  mappings.push({ orgId: "org1", agentId: "a2", agentVersion: version, skillVersionId: pkg.id, createdAt: new Date("2026-10-29") });
  agents[1].primarySkillId = pkg.skillId;
};

test.each(["twin", "legacy-twin"] as const)("getSkill uses verified %s package bytes without S3 or a ready index", async (format) => {
  agents[1].primarySkillId = "managed-skill";
  packages.push(managedPackage(format));
  expect(await run({ action: "getSkill", slug: "olga-objection-handling" })).toMatchObject({
    version: 2, skill: "# Managed instructions", items: [{ id: "managed" }], patterns: "Managed patterns",
    manifest: format === "twin" ? { skill: "objection-handling" } : { scenario: "objection-handling" },
  });
});

test("managed history resolves the requested Agent version, not the latest package", async () => {
  agents[1].primarySkillId = "managed-skill";
  packages.push(managedPackage(), { ...managedPackage("legacy-twin", "art/v1"), skillText: "# Corrupt projection" });
  await expect(run({ action: "getSkill", slug: "olga-objection-handling", version: 1 })).rejects.toMatchObject({ code: "skill_package_unavailable" });
  packages[1] = managedPackage("legacy-twin", "art/v1");
  expect(await run({ action: "getSkill", slug: "olga-objection-handling", version: 1 })).toMatchObject({ version: 1, skill: "# Managed instructions" });
});

test("broken or cross-org current managed references cannot fall back to compatibility data", async () => {
  agents[1].primarySkillId = "managed-skill";
  packages.push({ ...managedPackage(), skill: { orgId: "other", ownerSlug: "olga-objection-handling" } });
  await expect(run({ action: "getSkill", slug: "olga-objection-handling" })).rejects.toMatchObject({ code: "skill_package_unavailable" });
});

test("ambiguous managed package identity refuses rather than choosing a version", async () => {
  agents[1].primarySkillId = "managed-skill";
  packages.push(managedPackage(), managedPackage());
  await expect(run({ action: "getSkill", slug: "olga-objection-handling" })).rejects.toMatchObject({ code: "skill_package_unavailable" });
});

test.each(["twin", "legacy-twin", "builder-roleplay", "authored-roleplay"] as const)("mapped %s reads survive stripped package fields with the correct public kind", async (format) => {
  mapPackage(2, managedPackage(format));
  agents[1].data = { source: "obsolete", objective: "Keep experience" };
  agents[1].kind = format.includes("roleplay") ? "ROLEPLAY" : "TWIN";
  expect(await run({ action: "getSkill", slug: "olga-objection-handling" })).toMatchObject({
    version: 2, currentVersion: 2, skill: "# Managed instructions", items: [{ id: "managed" }],
    kind: format === "twin" ? "twin-skill" : format === "legacy-twin" ? "twin-skill-legacy" : format === "builder-roleplay" ? "roleplay-builder" : "roleplay-recordings",
  });
});

test("mapped history remains discoverable and readable without a SpecVersion snapshot", async () => {
  agents[1].version = 5;
  agents[1].data = { source: "twin-creator" };
  mapPackage(4, managedPackage("legacy-twin", "art/historical"));
  mapPackage(5, managedPackage("twin", "art/current"));
  const result = await run({ action: "getSkill", slug: "olga-objection-handling", version: 4 });
  expect(result).toMatchObject({
    version: 4, currentVersion: 5, kind: "twin-skill-legacy",
    versions: [{ version: 5, current: true }, { version: 4, savedAt: "2026-10-29T00:00:00.000Z" }, { version: 1, savedAt: "2026-10-28T00:00:00.000Z" }],
  });
});

test("mapped corruption and foreign ownership never fall back to otherwise valid saved artifacts", async () => {
  mapPackage(2, { ...managedPackage("twin", "art/mapped"), contentHash: "corrupted" });
  packages.push(managedPackage());
  await expect(run({ action: "getSkill", slug: "olga-objection-handling" })).rejects.toMatchObject({ code: "skill_package_unavailable" });
  packages[0] = { ...managedPackage("twin", "art/mapped"), skill: { orgId: "foreign", ownerSlug: "olga-objection-handling" } };
  await expect(run({ action: "getSkill", slug: "olga-objection-handling" })).rejects.toMatchObject({ code: "skill_package_unavailable" });
});

test("list hydrates package identity but preserves experience description and public shape", async () => {
  mapPackage(2, managedPackage());
  agents[1].data = { source: "twin-creator", objective: "Experience description" };
  const result = await run({ action: "list", kind: "twin" }) as { items: Row[] };
  expect(result.items[1]).toMatchObject({ skillId: "objection-handling", description: "Experience description", version: 2, kind: "twin-skill" });
  expect(result.items[1]).not.toHaveProperty("primarySkillId");
  expect(result.items[1]).not.toHaveProperty("data");
});

test("get hydrates a stripped roleplay builder while retaining After and Before experience settings", async () => {
  const rendered = renderRoleplay("objection-handling", {
    name: "Practice", persona: "olga", situation: { scenario: "Ask for a meeting", learnerRole: "Advisor" },
    difficulty: "medium", opening: "Why meet?", exampleLines: [], guardedIf: [], opensUpIf: [],
    learnerGoals: ["Published goal"], rubric: [{ name: "Published rubric", points: 100 }],
  });
  const pkg = managedPackage("builder-roleplay");
  const files = { ...pkg.files, "scenario.json": JSON.stringify(rendered.scenario) };
  mapPackage(2, { ...pkg, manifest: rendered.scenario, files, contentHash: skillPackageHash("builder-roleplay", files) });
  agents[1].kind = "ROLEPLAY";
  agents[1].data = {
    source: "roleplay-skill", objective: "Experience description",
    before: { preUpload: true }, after: { goals: ["Edited goal"], rubric: [{ name: "Edited rubric", points: 70 }] },
  };
  expect(await run({ action: "get", slug: "olga-objection-handling", kind: "roleplay" })).toMatchObject({
    kind: "roleplay-builder", version: 2, description: "Experience description",
    settings: { preUpload: true },
    builder: { name: "Practice", opening: "Why meet?", learnerGoals: ["Edited goal"], rubric: [{ name: "Edited rubric", points: 70 }] },
  });
});

test("each module reads only its own kind", async () => {
  agents.push({ id: "a4", orgId: "org1", slug: "olga-sara", name: "Sara", kind: "ROLEPLAY", version: 1, data: { source: "roleplay-skill" }, archivedAt: null, updatedAt: new Date() });
  const twins = await run({ action: "list", kind: "twin" }) as { items: { slug: string }[] };
  const roleplays = await run({ action: "list", kind: "roleplay" }) as { items: { slug: string }[] };
  expect(twins.items.map((i) => i.slug)).toEqual(["olga-olga-twin", "olga-objection-handling"]);
  expect(roleplays.items.map((i) => i.slug)).toEqual(["olga-sara"]);
  await expect(run({ action: "get", slug: "olga-sara", kind: "twin" })).rejects.toThrow(/is a role play, not a twin/);
  await expect(run({ action: "get", slug: "olga-objection-handling", kind: "roleplay" })).rejects.toThrow(/is a twin, not a role play/);
});

test.each(["twin", "roleplay"] as const)("inviteLearners %s describes queued emails without claiming failures", async (kind) => {
  agents[1].kind = kind === "twin" ? "TWIN" : "ROLEPLAY";
  delivery = { emailFailures: 0, emailsQueued: 2, emailProgress: "signed-token" };
  const result = await run({ action: "inviteLearners", slug: "olga-objection-handling", kind, emails: ["new@x.com", "other@x.com"] });
  expect(result).toMatchObject({ emails: "2 being sent; each is retried automatically, and the studio shows any that still fail" });
  for (const field of ["emailFailures", "emailsQueued", "emailProgress"]) expect(result).not.toHaveProperty(field);
});
test.each(["twin", "roleplay"] as const)("inviteLearners %s reports inline failures without queue metadata", async (kind) => {
  agents[1].kind = kind === "twin" ? "TWIN" : "ROLEPLAY";
  delivery = { emailFailures: 1, emailsQueued: 0 };
  const result = await run({ action: "inviteLearners", slug: "olga-objection-handling", kind, emails: ["new@x.com"] });
  expect(result).toMatchObject({ emailFailures: 1 });
  for (const field of ["emails", "emailsQueued", "emailProgress"]) expect(result).not.toHaveProperty(field);
});
