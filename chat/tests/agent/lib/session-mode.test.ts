import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, describe, test } from "node:test";
import channel from "../../../agent/channels/openai-compat";
import type { SessionSpecs, TwinPlaybook } from "../../../agent/lib/brain";
import { composeInstructions } from "../../../agent/lib/compose-instructions";
import { roleplaySkill } from "../../../agent/lib/roleplay";
import { CALIBRATION_FEEDBACK_EVENT, sessionMode, userInactiveEvent } from "../../../agent/lib/session-mode";
import { clearSessionModeCache, primeSessionMode } from "../../../agent/lib/session-mode-lookup";
import { interviewSpecs } from "../fixtures/interview-specs";

const golden = await readFile(new URL("../fixtures/interview-prompt.golden.txt", import.meta.url), "utf8");
const platform = await readFile(new URL("../../../prompts/platform.md", import.meta.url), "utf8");

const playbook: TwinPlaybook = { slug: "olga-objections", id: "objections", name: "Objections", description: "", steps: [], skill: "# Objections" };
const twinSpecs = {
  agentName: "Olga's twin", agentSlug: "olga-olga-twin", objective: "Answers questions", personaName: "Olga Sinenko", personaSlug: "olga",
  mode: "voice", documents: [], phases: [], twin: { playbooks: [playbook], inline: null },
  warmOpening: { style: { phrasingStyle: [{ text: "Hi, tell me", score: 1 }] } },
} as unknown as SessionSpecs;
const clientSpecs = {
  agentName: "Wait-and-see investor", agentSlug: "olga-wait", objective: "", phases: [], documents: [], mode: "voice", personaName: "Rohan",
  roleplay: roleplaySkill("ROLEPLAY", { skill: "# The investor", scenario: { difficulty: "easy" } }),
} as unknown as SessionSpecs;

// Interview wording that must never reach a twin or a client role play.
const INTERVIEW_WORDS = [/candidate/i, /INTERVIEW SETTINGS/, /focal question/i, /rapport question/i, /session_plan \(auto-initializes/, /next question/i];

describe("session mode", () => {
  test("one answer per session, role play first, calibration only for twins", () => {
    assert.equal(sessionMode({ roleplay: {}, twin: {}, calibration: true }), "roleplay-client");
    assert.equal(sessionMode({ twin: {} }), "twin");
    assert.equal(sessionMode({ twin: {}, calibration: true }), "twin-calibration");
    assert.equal(sessionMode({ calibration: true }), "roleplay-interview");
    assert.equal(sessionMode({ playbook: {} }), "legacy-playbook");
    assert.equal(sessionMode({}), "roleplay-interview");
  });
});

describe("composed instructions", () => {
  test("interview role plays (Vasanth's v1) are byte-identical to before modes", () => {
    assert.equal(sessionMode(interviewSpecs), "roleplay-interview");
    assert.equal(composeInstructions(interviewSpecs), golden);
  });

  test("a twin gets the platform rules and the twin contract, with no interview wording", () => {
    const prompt = composeInstructions(twinSpecs);
    assert.ok(prompt.includes(platform.trim()));
    assert.ok(!prompt.includes("Natural Onboarding Flow"), "not the interview base instructions");
    assert.ok(prompt.includes("TWIN — OPERATING INSTRUCTIONS FOR THIS SESSION"));
    assert.ok(prompt.includes("You are Olga Sinenko's twin"));
    assert.ok(prompt.includes("Never add a question after your advice"));
    assert.ok(prompt.includes("Never ask the learner about their own methods"));
    assert.ok(prompt.includes('Say exactly: "I can\'t answer this question, please ask the real Olga."'));
    assert.ok(!prompt.includes("CALIBRATION"), "learners never get the calibration overlay");
    assert.ok(!/\{\{[A-Z_]+\}\}/.test(prompt), "every placeholder filled");
    for (const word of INTERVIEW_WORDS) assert.doesNotMatch(prompt, word);
  });

  test("a twin calibration is the same twin plus the feedback overlay", () => {
    const learner = composeInstructions(twinSpecs);
    const calibration = composeInstructions({ ...twinSpecs, calibration: true });
    assert.equal(sessionMode({ ...twinSpecs, calibration: true }), "twin-calibration");
    assert.ok(calibration.includes("CALIBRATION — Olga Sinenko IS TESTING YOU"));
    assert.ok(calibration.includes("give the reply you should have given to the learner's last message, done their way"));
    // Everything a learner's twin gets is still there, unchanged.
    const [contract] = learner.split("\nYOUR PLAYBOOKS");
    assert.ok(calibration.startsWith(contract));
    for (const word of INTERVIEW_WORDS) assert.doesNotMatch(calibration, word);
  });

  test("a small twin carries its playbooks in full and its per-turn lines, still without interview wording", () => {
    const prompt = composeInstructions({ ...twinSpecs, twin: { playbooks: [playbook], inline: [playbook] } } as SessionSpecs);
    assert.ok(prompt.includes("YOUR PLAYBOOKS (in full)\n### Objections\n# Objections"));
    assert.ok(prompt.includes("do not call eve__skill or scenario_examples"));
    assert.ok(prompt.includes("[LINES FOR THIS MOMENT]"));
    assert.ok(prompt.includes("Never add a question after your advice"));
    assert.ok(!prompt.includes("load it with eve__skill"), "not the skills flow");
    assert.ok(!/end with one short question/.test(prompt));
    assert.ok(!/\{\{[A-Z_]+\}\}/.test(prompt), "every placeholder filled");
    for (const word of INTERVIEW_WORDS) assert.doesNotMatch(prompt, word);
  });

  test("a client role play gets the platform rules, not the interview base", () => {
    const prompt = composeInstructions(clientSpecs);
    assert.ok(prompt.includes(platform.trim()));
    assert.ok(prompt.includes("CLIENT ROLE-PLAY MODE"));
    assert.ok(prompt.includes("# Silence"));
    for (const word of INTERVIEW_WORDS) assert.doesNotMatch(prompt, word);
  });
});

describe("runtime events", () => {
  const handler = channel.routes!.find((route) => route.path === "/v1/chat/completions")!.handler as any;
  afterEach(() => clearSessionModeCache());

  /** The turn message the channel sends to eve for one transport message. */
  async function sent(sessionId: string, content: string, role = "user") {
    let message: string | undefined;
    const request = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-trainertwin-org-id": "org1", "x-trainertwin-session-id": sessionId, "x-trainertwin-agent-slug": "a" },
      body: JSON.stringify({ messages: [{ role, content }] }),
    });
    const info = console.info;
    console.info = () => {};
    try {
      const response: Response = await handler(request, {
        resolveSession: async () => undefined,
        waitUntil: () => {},
        from: () => ({ send: async (text: string) => {
          message = text;
          return { cancel: async () => {}, getEventStream: async () => new ReadableStream({ start(controller) { controller.close(); } }) };
        } }),
      });
      await response.text();
    } finally {
      console.info = info;
    }
    return message;
  }

  test("silence: interview texts are frozen; twins and clients get the fact, their instructions say what to do", async () => {
    primeSessionMode("org1", "iv", "a", "roleplay-interview");
    primeSessionMode("org1", "tw", "a", "twin");
    primeSessionMode("org1", "rp", "a", "roleplay-client");
    const inactive = "__TRAINERTWIN_USER_INACTIVE__";
    assert.equal(await sent("iv", inactive, "system"), "[USER INACTIVE] The learner has been silent for 60 seconds. Adapt to the current moment in the session. Do not advance the interview or ask a new interview question.");
    assert.equal(await sent("tw", inactive, "system"), "[USER INACTIVE] The learner has been silent for 60 seconds.");
    assert.equal(await sent("rp", inactive, "system"), userInactiveEvent("roleplay-client"));
  });

  test("\"Feels off\" is calibration feedback only in a twin calibration", async () => {
    primeSessionMode("org1", "cal", "a", "twin-calibration");
    primeSessionMode("org1", "tw", "a", "twin");
    assert.equal(await sent("cal", "Feels off"), CALIBRATION_FEEDBACK_EVENT);
    assert.equal(await sent("tw", "Feels off"), "Feels off");
  });
});
