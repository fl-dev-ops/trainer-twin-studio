import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { z } from "zod";
import { formatSessionSpec, scenarioPlaybook, type SessionSpecs } from "../../../agent/lib/brain";
import { roleplaySkill } from "../../../agent/lib/roleplay";
import scenarioExamples from "../../../agent/tools/scenario_examples";
import endCall from "../../../agent/tools/end_call";
import { clearSessionModeCache, isRoleplaySession, primeSessionMode, roleplayGuard } from "../../../agent/lib/session-mode-lookup";

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
  const originalFetch = globalThis.fetch;
  afterEach(() => { clearSessionModeCache(); globalThis.fetch = originalFetch; });

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

  test("authored practice follows its full skill, roles and attachments without the sales wrapper", () => {
    const skill = "# Technical discussion\nAsk what a closure retains. Follow the candidate's answer with a concrete example. End after they explain the mechanism.";
    const data = { source: "scenario-ingest", skill, scenario: { trainer_role: "interviewer", learner_role: "candidate" }, after: { rubric: [{ name: "private scoring criterion", points: 100 }] } };
    const authored = roleplaySkill("ROLEPLAY", data);
    assert.deepEqual(authored?.authored, { actorRole: "interviewer" });
    const prompt = formatSessionSpec({ ...base, roleplay: authored, tools: { canvas: false, preview: true, codeEditor: false, choice: false }, documents: [{ id: "resume-1", name: "CV.pdf", kind: "pdf", mimeType: "application/pdf", size: 100 }] });
    assert.match(prompt, /You play interviewer\. The learner plays candidate/);
    assert.ok(prompt.includes(skill));
    assert.match(prompt, /resume-1/);
    assert.match(prompt, /scenario_examples/);
    assert.match(prompt, /end_call\(\{ outcome: "completed" \}\)/);
    assert.doesNotMatch(prompt, /a CLIENT|a salesperson|# Guard level|private scoring criterion|say exactly:/);
    const withoutWorkspace = formatSessionSpec({ ...base, roleplay: authored });
    assert.match(withoutWorkspace, /Use read_document for attached document facts/);
    assert.match(withoutWorkspace, /No workspace surfaces are enabled/);
    assert.equal(roleplaySkill("ROLEPLAY", { source: "scenario-ingest", skill: " " }), undefined);
  });

  test("example lookup takes identity from the session and leaves the default side to Studio", async () => {
    process.env.COPILOT_SERVICE_SECRET ??= "test-secret";
    const calls: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url, init) => {
      const body = init?.body;
      assert.ok(typeof body === "string");
      calls.push(JSON.parse(body));
      return Response.json({ examples: [] });
    }) as typeof fetch;
    const ctx = { session: { auth: { current: { principalId: "org1", attributes: { sessionId: "call1", agentSlug: "acme-authored" } } } } } as unknown as Parameters<NonNullable<typeof scenarioExamples.execute>>[1];
    await scenarioExamples.execute!({ situation: "candidate explains closures", limit: 3 }, ctx);
    assert.deepEqual(calls[0], { action: "searchScenarioItems", agentSlug: "acme-authored", query: "candidate explains closures", limit: 3, sessionId: "call1" });
    await scenarioExamples.execute!({ situation: "candidate explains closures", role: "learner", limit: 3 }, ctx);
    assert.equal(calls[1].role, "learner");
  });

  test("an authored practice can end as completed; sessions that are not role plays still cannot use end_call", async () => {
    process.env.COPILOT_SERVICE_SECRET ??= "test-secret";
    const calls: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url, init) => {
      const body = init?.body;
      assert.ok(typeof body === "string");
      calls.push(JSON.parse(body));
      return Response.json({});
    }) as typeof fetch;
    const ctx = { session: { auth: { current: { principalId: "org1", attributes: { sessionId: "call1", agentSlug: "acme-authored" } } } } } as unknown as Parameters<NonNullable<typeof endCall.execute>>[1];
    const schema = endCall.inputSchema;
    assert.ok(schema instanceof z.ZodType);
    assert.equal(schema.safeParse({ outcome: "completed" }).success, true);
    primeSessionMode("org1", "call1", "acme-authored", "roleplay-client");
    assert.deepEqual(await endCall.execute!({ outcome: "completed" }, ctx), { status: "ended", outcome: "completed", instruction: "The call has ended. If you have not said goodbye yet, say one short goodbye in character; otherwise say nothing. Never mention the role play, the practice or the call having ended." });
    assert.deepEqual(calls, [{ action: "finishSession", sessionId: "call1" }]);
    primeSessionMode("org1", "call1", "acme-authored", "unavailable");
    assert.deepEqual(await endCall.execute!({ outcome: "completed" }, ctx), { disabled: true, reason: "end_call is only for skill-based role play. Other sessions end with finish_session." });
    assert.equal(calls.length, 1);
  });

  test("tool guard: trainer tools are disabled in role plays only (primed from the loaded context)", async () => {
    const ctx = (sessionId: string) => ({ session: { auth: { current: { principalId: "org1", attributes: { sessionId, agentSlug: "x" } } } } });
    primeSessionMode("org1", "rp", "x", "roleplay-client");
    primeSessionMode("org1", "tw", "x", "twin");
    assert.equal(await isRoleplaySession(ctx("rp")), true);
    assert.deepEqual(await roleplayGuard(ctx("rp")), { disabled: true, reason: "Not available in skill-based role play. Follow the role play and use its enabled tools." });
    assert.equal(await roleplayGuard(ctx("tw")), null);
    assert.equal(await isRoleplaySession({ session: { auth: { current: { principalId: "org1", attributes: {} } } } }), false);
  });
});

describe("ported interview (web/lib/interview-skill.ts): an authored skill where the AI is the interviewer", () => {
  const INTERVIEW = "---\nname: \"Impact Check\"\n---\n\n# Impact Check\n\n## Your role\n\nYou are the interviewer. The learner is the candidate.\n\n## Steps\n\n### `impact-validation` — Impact Validation\n\n**Interviewer goal:** Validate claims.\n";
  const ported = {
    name: "Impact Check (skill)", source: "scenario-ingest", skill: INTERVIEW,
    scenario: { scenario: "impact-check", trainer_role: "Interviewer", learner_role: "Candidate", steps: [{ id: "impact-validation", name: "Impact Validation", trainer_moves: [], learner_moves: [] }] },
    tools: { preview: true, codeEditor: false, canvas: false, choice: false },
  };

  test("runs as an authored role play: the AI plays the interviewer and follows the ported procedure", () => {
    const roleplay = roleplaySkill("ROLEPLAY", ported);
    assert.deepEqual(roleplay?.authored, { actorRole: "Interviewer" });
    assert.equal(roleplay?.learnerRole, "Candidate");
    const prompt = formatSessionSpec({ ...base, agentName: ported.name, roleplay, personaBrief: undefined, personaName: "Vasanth" });
    assert.match(prompt, /You play Interviewer\. The learner plays Candidate\./);
    assert.match(prompt, /You are the interviewer\. The learner is the candidate\./);
    assert.match(prompt, /Validate claims\./);
    assert.doesNotMatch(prompt, /CLIENT ROLE-PLAY MODE/);
    assert.doesNotMatch(prompt, /guard level/i);
  });

  test("the original no-skill interview keeps the interview mode", () => {
    assert.equal(roleplaySkill("ROLEPLAY", { name: "Impact Check", stages: [] }), undefined);
  });
});

describe("knowledge search switch", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { clearSessionModeCache(); globalThis.fetch = originalFetch; });

  test("knowledge tools run in twins; in a role play only when its Knowledge search is on", async () => {
    process.env.COPILOT_SERVICE_SECRET ??= "test-secret";
    const { knowledgeGuard } = await import("../../../agent/lib/session-mode-lookup");
    const ctx = (sessionId: string) => ({ session: { auth: { current: { principalId: "org1", attributes: { sessionId, agentSlug: "x" } } } } });
    globalThis.fetch = (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const on = body.sessionId === "rp-on";
      return Response.json({ agent: { kind: "ROLEPLAY", data: { tools: { knowledge: on } } } });
    }) as typeof fetch;
    primeSessionMode("org1", "tw", "x", "twin");
    primeSessionMode("org1", "rp-on", "x", "roleplay-client");
    primeSessionMode("org1", "rp-off", "x", "roleplay-client");
    assert.equal(await knowledgeGuard(ctx("tw")), null);
    assert.equal(await knowledgeGuard(ctx("rp-on")), null);
    assert.deepEqual(await knowledgeGuard(ctx("rp-off")), { disabled: true, reason: "Not available in skill-based role play. Follow the role play and use its enabled tools." });
  });

  test("the authored prompt tells the AI to search before judging only when the switch is on", () => {
    const data = { source: "scenario-ingest", skill: "# Interview", scenario: { trainer_role: "Interviewer", learner_role: "Candidate" } };
    const tools = { canvas: false, codeEditor: false, preview: false, choice: false };
    const on = formatSessionSpec({ ...base, roleplay: roleplaySkill("ROLEPLAY", data), tools: { ...tools, knowledge: true } });
    const off = formatSessionSpec({ ...base, roleplay: roleplaySkill("ROLEPLAY", data), tools });
    assert.match(on, /Knowledge search is on: call search_knowledge before you judge/);
    assert.doesNotMatch(off, /search_knowledge/);
  });
});
