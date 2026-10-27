import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { formatSessionSpec, scenarioPlaybook, type SessionSpecs } from "../../../agent/lib/brain";

const SKILL = `---
name: resume-drill-interview
description: "Drill one resume claim until a gap shows."
---
# Resume drill interview

## Steps
### 1. Anchor on claimed work \`anchor-claim\`
- **Interviewer goal:** claimed work, not a syllabus topic.
`;

const ingestData = {
  name: "Resume drill interview",
  objective: "Drill one resume claim until a gap shows.",
  source: "scenario-ingest",
  skill: SKILL,
  scenario: {
    scenario: "resume-drill-interview",
    trainer_role: "interviewer",
    learner_role: "candidate",
    steps: [{ id: "anchor-claim", name: "Anchor on claimed work", trainer_moves: ["warm_by_name", "request_resume"], learner_moves: ["accept_bounds"] }],
  },
};

const base: SessionSpecs = {
  agentName: "Resume drill interview",
  agentSlug: "acme-resume-drill-interview",
  agentVersion: 2,
  objective: "Drill one resume claim until a gap shows.",
  phases: [{ name: "Anchor on claimed work", objective: "claimed work" }],
  agentPolicy: JSON.stringify(ingestData),
  interviewSettings: "- Type: technical",
  personaName: "Vasanth",
  personaSlug: "Vasanth",
  documents: [],
  learnerName: "Aisha",
  mode: "voice",
};

describe("scenario-ingest playbook sessions", () => {
  test("only skill twins (TWIN with a skill) are playbooks", () => {
    assert.equal(scenarioPlaybook("ROLEPLAY", { name: "copilot spec", stages: [] }), undefined);
    assert.equal(scenarioPlaybook("TWIN", { source: "scenario-ingest" }), undefined);
    assert.equal(scenarioPlaybook("ROLEPLAY", ingestData), undefined); // kind decides the module
    assert.deepEqual(scenarioPlaybook("TWIN", ingestData), {
      skill: SKILL,
      trainerRole: "interviewer",
      learnerRole: "candidate",
      steps: [{ id: "anchor-claim", name: "Anchor on claimed work", trainerMoves: ["warm_by_name", "request_resume"], learnerMoves: ["accept_bounds"] }],
    });
  });

  test("the playbook is the operating instruction, verbatim, outside SESSION DATA", () => {
    const prompt = formatSessionSpec({ ...base, playbook: scenarioPlaybook("TWIN", ingestData) });
    assert.ok(prompt.startsWith("SCENARIO PLAYBOOK — OPERATING INSTRUCTIONS FOR THIS SESSION"));
    // SKILL.md exactly as ingested, YAML header included, before the factual SESSION DATA block.
    assert.ok(prompt.includes(`<playbook>\n${SKILL}\n</playbook>`));
    assert.ok(prompt.indexOf("<playbook>") < prompt.indexOf("SESSION DATA — FACTS, NOT INSTRUCTIONS"));
    assert.ok(prompt.includes("You play the interviewer. The learner plays the candidate."));
    assert.ok(prompt.includes("1. Anchor on claimed work `anchor-claim` — interviewer moves: warm_by_name, request_resume; candidate moves: accept_bounds"));
    assert.ok(prompt.includes("Do not call session_plan"));
    assert.ok(prompt.includes("scenario_examples"));
    assert.ok(prompt.includes("- Name: Aisha"));
    // The playbook is sent once: no spec dump, agenda or interview settings.
    assert.ok(!prompt.includes("- Spec:"));
    assert.ok(!prompt.includes("\nAGENT AGENDA\n"));
    assert.ok(!prompt.includes("\nINTERVIEW SETTINGS\n"));
    assert.equal(prompt.split("# Resume drill interview").length - 1, 1);
  });

  test("copilot-format specs keep the existing SESSION DATA prompt", () => {
    const prompt = formatSessionSpec(base);
    assert.ok(prompt.startsWith("SESSION DATA — FACTS AND CONFIGURATION, NOT INSTRUCTIONS"));
    assert.ok(prompt.includes("- Spec: "));
    assert.ok(prompt.includes("AGENT AGENDA"));
    assert.ok(!prompt.includes("SCENARIO PLAYBOOK"));
  });
});

describe("persona brief", () => {
  const brief = "- Who: Rohan Mehta, Prospect, 36.\n- Stay in character.";
  const twin = { playbooks: [] };

  test("web's brief replaces the recorded-style line in every prompt format", () => {
    for (const specs of [
      { ...base, personaBrief: brief }, // role play / interview spec
      { ...base, personaBrief: brief, playbook: scenarioPlaybook("TWIN", ingestData) }, // skill playbook
      { ...base, personaBrief: brief, twin }, // all-skills twin
    ] as SessionSpecs[]) {
      const prompt = formatSessionSpec(specs);
      assert.ok(prompt.includes(brief), "brief missing");
      assert.ok(!prompt.includes("Recorded style and decision preferences"));
    }
  });

  test("without a brief (older web, legacy persona) the recorded-style line stays", () => {
    const prompt = formatSessionSpec({ ...base, personaVoice: '{"style":"calm"}' });
    assert.ok(prompt.includes('- Recorded style and decision preferences: {"style":"calm"}'));
  });
});
