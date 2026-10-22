import { describe, expect, it } from "bun:test";
import {
  buildRoleplayBundle,
  clientPersonaCard,
  getStoredRoleplay,
  isClientPersonaData,
  isRoleplayAgentData,
  roleplayInputFromSpec,
  roleplayInputSchema,
  type RoleplayInput,
} from "@/lib/roleplay";
import { specDraftBundleSchema } from "@/lib/spec-draft-schema";
import { buildSpecs } from "@/lib/runtime/compiler";
import { formatSessionReportGrounding } from "@/lib/session-report-grounding";

const daniel: RoleplayInput = roleplayInputSchema.parse({
  name: "The wait-and-see investor",
  persona: "daniel-whitfield",
  clientName: "Daniel Hart",
  situation: {
    scenario: "You are a property investor talking to a Dubai real estate agent.",
    hiddenTruth: "You are scared of making a mistake with your family's savings.",
    learnerRole: "Agent calling a wait-and-see investor",
    agreesWhen: "Agrees to a short Zoom to look at the data together.",
    declinesWhen: "Politely ends with \"Let's leave it for now\".",
  },
  learnerGoals: [
    "Acknowledge the concern calmly, without arguing",
    "Find out why they started looking in the first place",
    "Leave with a Zoom or a dated follow-up",
  ],
  agent: {
    characterRole: "Warm but Cautious",
    difficulty: "medium",
    howTheyTalk: "Polite, a little guarded.",
    guardedIf: ["Uses fake urgency"],
    opensUpIf: ["Asks why now"],
    whatToExpect: "Listen first.",
  },
  opening: "The market has basically stopped. I'll wait for prices to hit the bottom, then I'll buy.",
});

describe("roleplay bundle", () => {
  const bundle = buildRoleplayBundle(daniel, { slug: "wait-and-see-investor" });

  it("passes the strict spec draft schema", () => {
    const parsed = specDraftBundleSchema.safeParse(bundle);
    expect(parsed.success ? null : parsed.error.issues).toBeNull();
  });

  it("compiles like a session activation snapshot", () => {
    const compiled = buildSpecs({
      persona: { id: "daniel-whitfield", version: 1, data: { kind: "client", name: "Daniel Whitfield" } },
      agent: { id: bundle.agent.id, version: 1, data: bundle.agent },
      domain: { id: bundle.domain.id, version: 1, data: bundle.domain },
      knowledgeBases: [],
    });
    expect(Object.values(compiled.agent.required_evidence)).toEqual(daniel.learnerGoals);
  });

  it("stores the builder fields under config.scenario.roleplay", () => {
    const stored = getStoredRoleplay(bundle.agent);
    expect(stored?.situation.hidden_truth).toContain("family's savings");
    expect(stored?.agent.reactions).toEqual({ guarded_if: ["Uses fake urgency"], opens_up_if: ["Asks why now"] });
    expect(bundle.agent.opening).toBe(daniel.opening);
    expect(isRoleplayAgentData(bundle.agent)).toBe(true);
  });

  it("round-trips into the editor fields", () => {
    expect(roleplayInputFromSpec(bundle.agent as unknown as Record<string, unknown>)).toEqual({ ...daniel, voiceId: undefined });
  });

  it("reports score the learner goals", () => {
    const grounding = formatSessionReportGrounding({
      persona: { id: "daniel-whitfield", version: 1, data: { kind: "client" } },
      agent: { id: bundle.agent.id, version: 1, data: bundle.agent },
      domain: { id: bundle.domain.id, version: 1, data: bundle.domain },
    }, {});
    for (const goal of daniel.learnerGoals) expect(grounding).toContain(goal);
  });
});

describe("Twin scenarios are not role-play", () => {
  it("treats interview specs as Twin", () => {
    const twin = { config: { scenario: {}, interview: { type: "resume" } }, stages: [] };
    expect(isRoleplayAgentData(twin)).toBe(false);
    expect(roleplayInputFromSpec(twin)).toBeNull();
  });
});

describe("input validation", () => {
  it("allows five learner goals at most", () => {
    const tooMany = { ...daniel, learnerGoals: ["a", "b", "c", "d", "e", "f"] };
    expect(roleplayInputSchema.safeParse(tooMany).success).toBe(false);
  });

  it("requires at least one learner goal and a persona", () => {
    expect(roleplayInputSchema.safeParse({ ...daniel, learnerGoals: [] }).success).toBe(false);
    expect(roleplayInputSchema.safeParse({ ...daniel, persona: "" }).success).toBe(false);
  });
});

describe("client personas", () => {
  it("only cards client personas", () => {
    expect(isClientPersonaData({ kind: "client" })).toBe(true);
    expect(isClientPersonaData({ name: "Vasanth", style: {} })).toBe(false);
    expect(clientPersonaCard("vasanth", { name: "Vasanth" })).toBeNull();
    expect(clientPersonaCard("daniel-whitfield", { kind: "client", name: "Daniel Whitfield", role: "Buyer" }))
      .toMatchObject({ slug: "daniel-whitfield", name: "Daniel Whitfield", role: "Buyer", behaviours: [] });
  });
});
