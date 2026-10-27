import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";
import { BASE_INSTRUCTIONS_HEADER, baseInstructions, coreInstructions, CORE_HEADINGS } from "../../../agent/lib/base-instructions";
import { formatSessionSpec, isAllSkillsTwin, playbookSkillNames, type SessionSpecs, type TwinPlaybook } from "../../../agent/lib/brain";

const full = await readFile(new URL("../../../prompts/base-instructions.md", import.meta.url), "utf8");

describe("base instructions", () => {
  test("interview sessions get the whole file, framed as eve framed static instructions", () => {
    assert.equal(baseInstructions(full, false), BASE_INSTRUCTIONS_HEADER + full.trim());
  });

  test("playbook and twin sessions get every core section, verbatim and much shorter", () => {
    const core = coreInstructions(full);
    assert.ok(core, "a core heading is missing from base-instructions.md");
    for (const heading of CORE_HEADINGS) assert.ok(core.includes(heading));
    assert.ok(core.includes("ABSOLUTE BAN on Markdown formatting"));
    assert.ok(core.includes("NEVER speak for the candidate"));
    assert.ok(!core.includes("Session Plan & Progress Tracking"));
    assert.ok(!core.includes("Resume interview claim boundary"));
    for (const block of core.split("\n\n")) assert.ok(full.includes(block), `not verbatim: ${block.slice(0, 60)}`);
    assert.ok(core.length < full.length / 3);
  });

  test("a missing core heading falls back to the whole file", () => {
    const edited = full.replace("## 2. Identity & Name Lock Rules", "## 2. Identity");
    assert.equal(coreInstructions(edited), null);
    assert.equal(baseInstructions(edited, true), BASE_INSTRUCTIONS_HEADER + edited.trim());
  });
});

const playbook = (id: string, name: string): TwinPlaybook => ({ slug: `acme-${id}`, id, name, description: `${name} desc`, steps: [], skill: `# ${name}` });

describe("twin", () => {
  test("recognises the all-skills twin by kind, then provenance", () => {
    assert.equal(isAllSkillsTwin("TWIN", { source: "twin" }), true);
    assert.equal(isAllSkillsTwin("TWIN", { source: "scenario-ingest" }), false); // a skill twin
    assert.equal(isAllSkillsTwin("ROLEPLAY", { source: "twin" }), false); // kind decides the module
    assert.equal(isAllSkillsTwin(undefined, { source: "twin" }), false);
  });

  test("skill names are valid eve names and unique", () => {
    const names = playbookSkillNames([playbook("off-plan", "A"), playbook("off plan!", "B"), playbook("9-lives", "C"), playbook("off-plan", "D")]);
    assert.deepEqual(names, ["off-plan", "off-plan-", "lives", "off-plan-2"]);
    for (const name of names) assert.match(name, /^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
  });

  test("twin sessions get the twin block with a playbook list, not the interview spec", () => {
    const specs = {
      agentName: "Olga's twin", agentSlug: "acme-olga-twin", objective: "Answers questions", personaName: "Olga", personaSlug: "olga",
      mode: "voice", documents: [], phases: [], twin: { playbooks: [playbook("off-plan", "Off-plan coaching"), playbook("objections", "Objections")] },
    } as unknown as SessionSpecs;
    const prompt = formatSessionSpec(specs);
    assert.ok(prompt.startsWith("TWIN — OPERATING INSTRUCTIONS FOR THIS SESSION"));
    assert.ok(prompt.includes("You are Olga's twin"));
    assert.ok(prompt.includes("- `off-plan`: Off-plan coaching"));
    assert.ok(prompt.includes("- `objections`: Objections"));
    assert.ok(prompt.includes("Do not call session_plan"));
    assert.ok(prompt.includes("Do not call search_knowledge"));
    assert.ok(prompt.includes("comes to you with a real situation"));
    assert.ok(prompt.includes("the exact words to say to their client"));
    assert.ok(prompt.includes("Do not offer practice or a role play"));
    assert.ok(!prompt.includes("Off-plan coaching desc"), "descriptions come from eve's skill announcement");
    assert.ok(!prompt.includes("INTERVIEW SETTINGS"));
  });
});

describe("twin-creator skills", () => {
  const skillData = {
    source: "twin-creator",
    skill: "---\nname: off-plan-waiting\n---\n## Topic\nI help when a buyer waits for prices.",
    scenario: { skill: "off-plan-waiting", name: "Buyers who wait for prices", description: "When a buyer says they will wait", situations: [{ id: "buyer-waits", name: "The buyer waits" }] },
  };

  test("a single twin skill advises from its own topic: it is its only playbook, and never a scenario runner", async () => {
    const { scenarioPlaybook, twinSessionPlaybooks } = await import("../../../agent/lib/brain");
    assert.equal(scenarioPlaybook("TWIN", skillData), undefined);
    const [own] = twinSessionPlaybooks({ slug: "olga-off-plan-waiting", kind: "TWIN", data: skillData }, undefined)!;
    assert.deepEqual(own, {
      slug: "olga-off-plan-waiting", id: "off-plan-waiting", name: "Buyers who wait for prices", description: "When a buyer says they will wait",
      steps: [{ id: "buyer-waits", name: "The buyer waits" }], skill: skillData.skill,
    });
    // Not a twin skill: a role play, an older scenario-ingest skill twin, or no agent.
    assert.equal(twinSessionPlaybooks({ kind: "ROLEPLAY", data: { ...skillData } }, undefined), undefined);
    assert.equal(twinSessionPlaybooks({ kind: "TWIN", data: { ...skillData, source: "scenario-ingest" } }, undefined), undefined);
    assert.equal(twinSessionPlaybooks(null, undefined), undefined);
    // The all-skills twin keeps every playbook web sends.
    assert.deepEqual(twinSessionPlaybooks({ kind: "TWIN", data: { source: "twin" } }, [own]), [own]);
  });

  test("the twin prompt treats playbooks as judgment on a topic, not as a role play", () => {
    const prompt = formatSessionSpec({
      agentName: "Buyers who wait", agentSlug: "olga-off-plan-waiting", objective: "x", personaName: "Olga", personaSlug: "olga",
      mode: "voice", documents: [], phases: [], twin: { playbooks: [playbook("off-plan-waiting", "Buyers who wait for prices")] },
    } as unknown as SessionSpecs);
    assert.ok(prompt.startsWith("TWIN — OPERATING INSTRUCTIONS FOR THIS SESSION"));
    assert.ok(prompt.includes("This is not a lesson and not a role play."));
    assert.ok(prompt.includes("A playbook holds your knowledge, decisions, patterns and approach on one topic"));
  });
});
