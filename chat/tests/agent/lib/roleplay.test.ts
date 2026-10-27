import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { formatSessionSpec, scenarioPlaybook, type SessionSpecs } from "../../../agent/lib/brain";
import { clearRoleplayCache, isRoleplaySession, primeRoleplayCache, roleplayGuard, roleplaySkill } from "../../../agent/lib/roleplay";

// What web's role-play builder stores (lib/roleplay/skill.ts renderRoleplay), trimmed.
const SKILL = `---
name: wait-and-see-investor
description: "The wait-and-see investor: practise a call with a prospect."
---

# The wait-and-see investor

## Who you are on this call
On this call your name is Daniel Hart.

## What is really going on
Inflation and taxes at home are eating into your savings.

## Reactions
### You get more guarded when the learner:
- Uses fake urgency, like "last units"
`;

const roleplayData = {
  name: "The wait-and-see investor",
  source: "roleplay-skill",
  skill: SKILL,
  scenario: {
    scenario: "wait-and-see-investor",
    trainer_role: "Prospect",
    learner_role: "Agent calling a wait-and-see investor",
    difficulty: "hard",
    steps: [{ id: "opening", name: "The client answers", trainer_moves: ["answer_call"], learner_moves: ["introduce"] }],
    roleplay: { clientName: "Daniel Hart", opening: "The market has basically stopped. I'll wait for prices to hit the bottom." },
  },
  after: { report: "roleplay", goals: ["Find out why they started looking"], rubric: [{ name: "Dated follow-up", points: 15 }] },
};

const base: SessionSpecs = {
  agentName: "The wait-and-see investor",
  agentSlug: "acme-wait-and-see-investor",
  agentVersion: 1,
  objective: "",
  phases: [],
  personaName: "Rohan Mehta",
  personaSlug: "off-plan-lead-waiting-for-prices",
  personaBrief: "- Name: Rohan Mehta\n- Behaviour: Skeptical & Reserved",
  documents: [],
  learnerName: "Aisha",
  mode: "voice",
};

describe("client role play (kind ROLEPLAY with a SKILL.md)", () => {
  afterEach(() => clearRoleplayCache());

  test("only ROLEPLAY agents with a skill are role plays; difficulty, opening and client name come from scenario.json", () => {
    assert.equal(roleplaySkill("TWIN", roleplayData), undefined);
    assert.equal(roleplaySkill("ROLEPLAY", { config: { interview: {} } }), undefined); // older interview role play
    assert.deepEqual(roleplaySkill("ROLEPLAY", roleplayData), {
      skill: SKILL,
      difficulty: "hard",
      learnerRole: "Agent calling a wait-and-see investor",
      clientName: "Daniel Hart",
      opening: "The market has basically stopped. I'll wait for prices to hit the bottom.",
    });
    assert.equal(roleplaySkill("ROLEPLAY", { ...roleplayData, scenario: { ...roleplayData.scenario, difficulty: "weird" } })?.difficulty, "medium");
    // A role play is never a twin playbook.
    assert.equal(scenarioPlaybook("ROLEPLAY", roleplayData), undefined);
  });

  test("prompt: client mode with persona brief + SKILL.md + difficulty; never the goals or rubric", () => {
    const prompt = formatSessionSpec({ ...base, roleplay: roleplaySkill("ROLEPLAY", roleplayData) });
    assert.ok(prompt.startsWith("CLIENT ROLE-PLAY MODE"));
    assert.match(prompt, /You are Daniel Hart, a CLIENT\. The person talking to you plays Agent calling a wait-and-see investor/);
    assert.match(prompt, /- Behaviour: Skeptical & Reserved/);
    assert.match(prompt, /On this call you are Daniel Hart\. The lines above are your defaults\. Where the role play below says something different for this call .*or how you talk\), the role play wins\./);
    assert.match(prompt, /<roleplay>\n---\nname: wait-and-see-investor[\s\S]*Inflation and taxes[\s\S]*<\/roleplay>/);
    assert.match(prompt, /# Difficulty: hard\nConfident and testing/);
    assert.match(prompt, /You start at guard level 3/);
    assert.match(prompt, /say exactly: "The market has basically stopped/);
    assert.match(prompt, /call end_call/);
    assert.match(prompt, /- Name: Aisha/);
    assert.doesNotMatch(prompt, /Find out why they started looking|Dated follow-up/);
    assert.doesNotMatch(prompt, /SCENARIO PLAYBOOK|TWIN —|session_plan\(/);
    // Chat mode wording.
    assert.match(formatSessionSpec({ ...base, mode: "chat", roleplay: roleplaySkill("ROLEPLAY", roleplayData) }), /This is a live chat/);
  });

  test("tool guard: trainer tools are disabled in role plays only (primed from the loaded context)", async () => {
    const ctx = (sessionId: string) => ({ session: { auth: { current: { principalId: "org1", attributes: { sessionId, agentSlug: "x" } } } } });
    primeRoleplayCache("org1", "rp", "x", true);
    primeRoleplayCache("org1", "tw", "x", false);
    assert.equal(await isRoleplaySession(ctx("rp")), true);
    assert.deepEqual(await roleplayGuard(ctx("rp")), { disabled: true, reason: "Not available in client role play. Stay in character and answer as the client." });
    assert.equal(await roleplayGuard(ctx("tw")), null);
    assert.equal(await isRoleplaySession({ session: { auth: { current: { principalId: "org1", attributes: {} } } } }), false);
  });
});
