import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderRoleplay, roleplayBuilderFrom, roleplayBuilderSchema, roleplayItemSchema } from "@/lib/roleplay/skill";
import { scenarioManifestSchema, skillBody, stepGoal } from "@/lib/scenario-ingest";

const SEEDS = join(import.meta.dir, "../../data/roleplay/skills");
const seeds = readdirSync(SEEDS).map((slug) => ({ slug, builder: JSON.parse(readFileSync(join(SEEDS, slug, "builder.json"), "utf8")) }));

test("both seeds are valid builder input", () => {
  expect(seeds.map((s) => s.slug).sort()).toEqual(["options-collector", "wait-and-see-investor"]);
  for (const seed of seeds) expect(roleplayBuilderSchema.safeParse(seed.builder).success).toBe(true);
});

test("render: the same package a twin skill is, valid for the scenario manifest; goals and rubric only in after", () => {
  for (const { slug, builder } of seeds) {
    const out = renderRoleplay(slug, builder, "Prospect");
    expect(out.skill.startsWith(`---\nname: ${slug}\ndescription: "`)).toBe(true);
    expect(scenarioManifestSchema.safeParse(out.scenario).success).toBe(true);
    expect(out.scenario.trainer_role).toBe("Prospect");
    expect(out.scenario.steps.map((s) => s.id)).toEqual(["opening", "objection", "close"]);
    for (const item of out.items) expect(roleplayItemSchema.safeParse(item).success).toBe(true);
    // The opening line is each persona's character, not the stage's: items are the shared example lines only.
    expect(out.items.map((item) => item.text)).toEqual(builder.exampleLines);
    expect(out.after).toEqual({ report: "roleplay", goals: builder.learnerGoals, rubric: builder.rubric });
    // The AI client never sees how the learner is scored.
    const body = skillBody(out.skill);
    for (const goal of builder.learnerGoals) expect(body).not.toContain(goal);
    for (const row of builder.rubric) expect(body).not.toContain(row.name);
    expect(JSON.stringify(out.scenario)).not.toContain(builder.rubric[0].name);
    // The stage holds no one persona's part (hidden truth, opening, reactions): those are characters.
    expect(body).not.toContain(builder.situation.hiddenTruth.slice(0, 40));
    expect(body).not.toContain(builder.opening);
    expect(body).not.toContain("## Reactions");
    // Persona-neutral: an older builder's client name is dropped; the persona playing it gives the name.
    expect(body).toContain("You are the persona described in PERSONA, as your CHARACTER for this role play describes you.");
    expect(body).not.toContain("On this call your name is");
    // Steps sit where the twin skill parser looks for them.
    expect(stepGoal(body, "opening")).toBeUndefined();
    expect(body).toContain("### 1. The client answers `opening`");
  }
});

test("render is stable and reads back exactly what was saved", () => {
  const { slug, builder } = seeds[0];
  const first = renderRoleplay(slug, builder);
  expect(renderRoleplay(slug, builder)).toEqual(first);
  const data = { skill: first.skill, scenario: first.scenario, after: first.after };
  expect(roleplayBuilderFrom(data)).toEqual(roleplayBuilderSchema.parse(builder));
  expect(roleplayBuilderFrom({})).toBeNull();
});

test("limits: at least one goal, at most five; rubric 1..8; slug must be kebab-case", () => {
  const { builder } = seeds[0];
  expect(() => renderRoleplay("x", { ...builder, learnerGoals: [] })).toThrow();
  expect(() => renderRoleplay("x", { ...builder, learnerGoals: ["a", "b", "c", "d", "e", "f"] })).toThrow();
  expect(() => renderRoleplay("x", { ...builder, rubric: Array.from({ length: 9 }, (_, i) => ({ name: `c${i}`, points: 10 })) })).toThrow();
  expect(() => renderRoleplay("Not Kebab", builder)).toThrow();
  expect(() => renderRoleplay("x", { ...builder, situation: { ...builder.situation, learnerRole: "x".repeat(101) } })).toThrow();
  expect(renderRoleplay("x", { ...builder, situation: { ...builder.situation, learnerRole: "x".repeat(100) } }).scenario.learner_role).toHaveLength(100);
  // Without example lines there are no items.
  expect(renderRoleplay("bare", { ...builder, exampleLines: [] }).items).toHaveLength(0);
});
