import { expect, test } from "bun:test";
import { checkBrief, draftBrief, renderBrief, roleplayBriefSchema, STANDARD_RULES, type RoleplayBriefInput } from "@/lib/roleplay/brief";
import { scenarioItemSchema, scenarioManifestSchema, skillBody, stepGoal } from "@/lib/scenario-ingest";
import { briefFixtures } from "../fixtures/roleplay-briefs";

const SECTIONS = ["## Your role", "## The learner", "## Situation", "## How it starts", "## How the conversation goes", "## How you react", "## How it ends", "## Rules", "## How real people talk"];
const fixture = (name: keyof typeof briefFixtures) => structuredClone(briefFixtures[name].brief);
const reasonsFor = (brief: RoleplayBriefInput) => checkBrief(roleplayBriefSchema.parse(brief));

test.each(Object.keys(briefFixtures))("%s: a complete brief renders every section, a valid manifest and items", (name) => {
  const draft = draftBrief(briefFixtures[name].brief);
  expect(draft.reasons).toEqual([]);
  expect(draft.ok).toBe(true);
  if (!draft.ok) return;
  for (const section of SECTIONS) expect(draft.skill).toContain(section);
  expect(draft.skill.startsWith(`---\nname: ${draft.brief.id}\n`)).toBe(true);
  for (const rule of STANDARD_RULES) expect(draft.skill).toContain(rule);
  // The manifest and items are what the shared publisher and runtime accept.
  expect(scenarioManifestSchema.safeParse(draft.scenario).success).toBe(true);
  expect(draft.scenario).toMatchObject({ trainer_role: draft.brief.ai.role, learner_role: draft.brief.learner.role, description: draft.brief.learnerBrief });
  for (const item of draft.items) expect(scenarioItemSchema.safeParse(item).success).toBe(true);
  expect(draft.items).toHaveLength(draft.brief.items.length);
  // Every step's goal is readable the way the runtime reads authored skills.
  for (const step of draft.brief.steps) expect(stepGoal(skillBody(draft.skill), step.id)).toBe(step.what);
  // The stage names no persona; the persona's part is its character.
  expect(draft.skill).not.toContain(briefFixtures[name].persona.name);
  expect(briefFixtures[name].character).toContain("## How you react");
});

test("rendering is deterministic: the same brief gives byte-identical files", () => {
  const brief = roleplayBriefSchema.parse(fixture("olga-first-call"));
  expect(renderBrief(brief)).toEqual(renderBrief(roleplayBriefSchema.parse(fixture("olga-first-call"))));
});

test("the brief is written to the AI as \"you\", with how it starts for each opener", () => {
  const ai = draftBrief(fixture("olga-first-call"));
  const learner = draftBrief(fixture("flo-keynote-qa"));
  if (!ai.ok || !learner.ok) throw new Error("fixtures must pass");
  expect(ai.skill).toContain("You speak first, with your character's opening line.");
  expect(learner.skill).toContain("The learner starts the conversation: The speaker names their keynote topic in one line.");
  expect(learner.skill).toContain("On the opening turn, before the learner has said anything, say only a short, neutral line");
  expect(ai.skill).toContain("Reveal what your character keeps hidden only when the learner asks a genuine question about it and listens");
  // The persona's part moved to its character: opening line, first reply, hidden concerns.
  expect(ai.skill).not.toContain("Ravi speaking");
  expect(briefFixtures["olga-first-call"].character).toContain('## Your opening line\n\n"Hello, yes, Ravi speaking."');
  expect(briefFixtures["flo-keynote-qa"].character).toContain('## Your first reply\n\n"We\'ve heard ideas like this before. Why would this one work?"');
  expect(briefFixtures["olga-first-call"].character).toContain("(hidden until earned) You don't really understand how a Dubai mortgage works");
  expect(ai.skill).toContain('If you end it early or without a next step, say only: "I\'ve got to go, just send me something on WhatsApp." A good ending closes naturally instead.');
  expect(ai.skill).toContain("## Using your lines");
  // Without items, the skill has no "Using your lines" section.
  expect(draftBrief(fixture("bevan-missed-deadlines"))).toMatchObject({ ok: true, skill: expect.not.stringContaining("## Using your lines") });
});

test("items keep their kind, step and tags, and are marked as written by the trainer", () => {
  const draft = draftBrief(fixture("olga-objections"));
  if (!draft.ok) throw new Error("fixture must pass");
  expect(draft.items[0]).toEqual({
    id: "olga-objections-faisal-objection-1", role: "trainer", context: "objection (any): A stall objection.", text: "I'll come back to you.",
    metadata: { step: "stall", kind: "objection", source: "authored", tags: ["any"] },
  });
  expect(draft.items.filter((item) => item.metadata.tags?.includes("investor")).length).toBeGreaterThan(5);
});

test("checks catch an incomplete or inconsistent brief", () => {
  const same = fixture("bevan-missed-deadlines");
  same.learner.role = "employee";
  expect(reasonsFor(same)).toContain("The AI and the learner play the same role; give each a distinct role.");

  const learnerFirst = fixture("flo-keynote-qa");
  delete learnerFirst.start.learnerFirst;
  expect(reasonsFor(learnerFirst)).toContain("The learner speaks first: say what they do first (start.learnerFirst).");

  const noEnd = fixture("bevan-missed-deadlines");
  delete noEnd.ending.limit;
  noEnd.ending.good = "A good conversation.";
  expect(reasonsFor(noEnd)).toContain("Say when the conversation ends: a time or count limit, or what ends it.");

  const badStep = fixture("jameel-technical-round");
  badStep.items![0].step = "nowhere";
  expect(reasonsFor(badStep).join(" ")).toContain('names step "nowhere"');

  const dup = fixture("jameel-technical-round");
  dup.items!.push({ ...dup.items![0] });
  expect(reasonsFor(dup).join(" ")).toContain("Item listed twice");

  const noGuide = fixture("jameel-technical-round");
  delete noGuide.itemsGuide;
  expect(reasonsFor(noGuide)).toContain("There are items: add itemsGuide (when to pull which kind).");

  const contact = fixture("bevan-missed-deadlines");
  contact.situation.push("Reach the founder at founder@example.com.");
  expect(reasonsFor(contact).join(" ")).toContain("Remove personal or contact details");

  const dupSteps = fixture("bevan-missed-deadlines");
  dupSteps.steps[1].id = dupSteps.steps[0].id;
  expect(reasonsFor(dupSteps)).toContain("Step ids must be unique.");
});

test("schema refusals come back as readable reasons, not exceptions", () => {
  const missing = fixture("bevan-missed-deadlines") as Record<string, unknown>;
  delete missing.summary;
  // A persona's part written into the brief comes back as a reason to move it to the character.
  const persona = { ...fixture("bevan-missed-deadlines"), wants: "A fair hearing", start: { who: "ai", openingLine: "Hi." } };
  expect(draftBrief(persona)).toMatchObject({ ok: false, reasons: [expect.stringContaining("wants, start.openingLine: these belong to each persona's character")] });
  const tooFewSteps = fixture("bevan-missed-deadlines");
  tooFewSteps.steps = tooFewSteps.steps.slice(0, 1);
  expect(draftBrief(missing)).toMatchObject({ ok: false, reasons: [expect.stringContaining("summary")] });
  expect(draftBrief(tooFewSteps)).toMatchObject({ ok: false, reasons: [expect.stringContaining("steps")] });
  expect(draftBrief({ ...fixture("bevan-missed-deadlines"), score: [1] })).toMatchObject({ ok: false });
});
