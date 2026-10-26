import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";
import { BASE_INSTRUCTIONS_HEADER, baseInstructions, coreInstructions, CORE_HEADINGS } from "../../../agent/lib/base-instructions";
import { formatSessionSpec, isTwinData, playbookSkillNames, type SessionSpecs, type TwinPlaybook } from "../../../agent/lib/brain";

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
  test("recognises twin agents", () => {
    assert.equal(isTwinData({ source: "twin" }), true);
    assert.equal(isTwinData({ source: "scenario-ingest" }), false);
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
