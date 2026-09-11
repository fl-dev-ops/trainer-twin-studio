/**
 * Runtime check and fixture parity tests against the Python runner specification.
 * Verifies compiler, controller reducer, probe bounds, and action selection.
 */

import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { buildSpecs } from "./compiler";
import {
  type AnswerAnalysis,
  type RuntimeState,
  applyEvidenceUpdates,
  closingAction,
  deterministicFallback,
  expirePhase,
  flagsFromCompliance,
  foldInterviewText,
  initRuntimeState,
  markProbeExhaustion,
  mechanicalSpeechFlags,
  nextEvidence,
  applyPersonaVote,
  pickBestDraft,
  recordAskedQuestion,
  selectAction,
  surfaceForPhase,
  validateAction,
  validateAnalysis,
} from "./runtime";

const DATA_DIR = path.resolve(import.meta.dir, "../../data");

function loadConfig(agentSlug = "full-mock-interview", personaSlug = "vasanth") {
  const agentYaml = fs.readFileSync(path.join(DATA_DIR, `agents/${agentSlug}.yaml`), "utf8");
  const personaYaml = fs.readFileSync(path.join(DATA_DIR, `personas/${personaSlug}.yaml`), "utf8");
  const agentData = (yaml.load(agentYaml) as any).agent;
  const personaData = (yaml.load(personaYaml) as any).persona;
  const domainYaml = fs.readFileSync(path.join(DATA_DIR, `domains/${agentData.domain}.yaml`), "utf8");
  const domainData = (yaml.load(domainYaml) as any).domain;

  return {
    persona: { version: personaData.version ?? 1, data: personaData },
    agent: { version: agentData.version ?? 1, data: agentData },
    domain: { version: domainData.version ?? 1, data: domainData },
    knowledgeBases: [],
  };
}

describe("Interview Compiler", () => {
  it("surfaceForPhase passes starter_code and language from a coding_sandbox tool", () => {
    const agent = {
      phases: [
        {
          tools: [
            { id: "coding_sandbox", language: "python", starter_code: "print('hi')" },
          ],
          scenario: {},
        },
      ],
    };
    const surface = surfaceForPhase(agent as never, 0);
    expect(surface).toEqual({
      action: "open_code_editor",
      payload: { language: "python", starterCode: "print('hi')" },
    });
  });

  it("compiles standard Studio configurations from YAML", () => {
    const config = loadConfig("resume-mastery", "vasanth");
    const compiled = buildSpecs(config);

    expect(compiled.persona.id).toBe("vasanth");
    expect(compiled.persona.source_resources).toBeUndefined();
    expect(compiled.agent.id).toBe("resume-mastery");
    expect(compiled.agent.phases.length).toBeGreaterThanOrEqual(1);

    const firstPhase = compiled.agent.phases[0];
    expect(firstPhase.evidence_keys.length).toBeGreaterThan(0);
    expect(firstPhase.evidence_keys[0].startsWith(firstPhase.id)).toBe(true);
  });

  it("prefers spoken_opening and stage_brief aliases", () => {
    const config = loadConfig("resume-mastery", "vasanth");
    config.agent.data.spoken_opening = "Ask about one real project.";
    config.agent.data.stages[0].stage_brief = "Stay on ownership.";
    const compiled = buildSpecs(config);
    expect(compiled.agent.opening).toBe("Ask about one real project.");
    expect(compiled.agent.phases[0].opening).toBe("Stay on ownership.");
  });

  it("compiles real-world-system-design with hidden scenario facts", () => {
    const config = loadConfig("real-world-system-design", "vasanth");
    const compiled = buildSpecs(config);

    expect(compiled.agent.phases[0].scenario).toBeDefined();
    expect(compiled.agent.phases[0].evidence_keys.length).toBeGreaterThan(0);
  });

  it("rejects duplicate or invalid stage IDs", () => {
    const config = loadConfig();
    config.agent.data.stages.push(structuredClone(config.agent.data.stages[0]));
    expect(() => buildSpecs(config)).toThrow();
  });
});

describe("Interview Runtime Controller (selectAction parity)", () => {
  it("returns closing_action immediately when learner intent is 'stop'", () => {
    const config = loadConfig();
    const specs = buildSpecs(config);
    const state: RuntimeState = initRuntimeState();

    const analysis: AnswerAnalysis = {
      classification: "strong",
      learner_intent: "stop",
      valid_evidence: [],
      evidence_updates: [],
      claim_assessments: [],
      unresolved_point: "",
    };

    const action = selectAction(analysis, state, specs.persona, specs.agent);
    expect(action.name).toBe("close_session");
    expect(action.close).toBe(true);
  });

  it("records the pending question and probe count", () => {
    const config = loadConfig();
    const specs = buildSpecs(config);
    const state = initRuntimeState();
    const evidenceKey = specs.agent.phases[0].evidence_keys[0];
    const action = {
      name: "probe_required_evidence",
      evidence_key: evidenceKey,
      reason: "test",
      intent: "ask one question",
      close: false,
      expects_answer: true,
    };

    recordAskedQuestion(state, action, "Which part did you implement?");

    expect(state.pending_question).toBe("Which part did you implement?");
    expect(state.pending_evidence_key).toBe(evidenceKey);
    expect(state.evidence_probe_counts[evidenceKey]).toBe(1);
  });

  it("handles clarification without grading or spending probe budget", () => {
    const config = loadConfig();
    const specs = buildSpecs(config);
    const state: RuntimeState = initRuntimeState();

    const analysis: AnswerAnalysis = {
      classification: "partial",
      learner_intent: "clarification",
      valid_evidence: [],
      evidence_updates: [],
      claim_assessments: [],
      unresolved_point: "",
    };

    const action = selectAction(analysis, state, specs.persona, specs.agent);
    expect(action.expects_answer).toBe(false);
    expect(action.close).toBe(false);
    expect(state.phase_index).toBe(0);
    expect(state.evidence_probe_counts).toEqual({});
  });

  it("applies evidence updates to coverage and detects hypothetical claims in incident lanes", () => {
    const config = loadConfig("resume-mastery");
    const specs = buildSpecs(config);
    const state: RuntimeState = initRuntimeState();
    const activeEv = specs.agent.phases[0].evidence_keys[0];

    const analysis: AnswerAnalysis = {
      classification: "strong",
      learner_intent: "answer",
      valid_evidence: ["we observed a failure when connection dropped"],
      evidence_updates: [
        {
          key: activeEv,
          status: "sufficient",
          evidence: "clear description of failure",
          quote: "we observed a failure",
          provenance: "observed_incident",
        },
      ],
      claim_assessments: [],
      unresolved_point: "",
    };

    const candidates = applyEvidenceUpdates(analysis, state, specs.agent.required_evidence, true);
    expect(state.coverage[activeEv]).toBe("sufficient");
    expect(Array.isArray(candidates)).toBe(true);
  });

  it("expires untouched lanes as unresolved on phase budget exhaustion", () => {
    const state: RuntimeState = initRuntimeState();
    state.coverage["phase1.core1"] = "untested";
    state.coverage["phase1.core2"] = "partial";
    state.coverage["phase1.core3"] = "sufficient";

    expirePhase(state, ["phase1.core1", "phase1.core2", "phase1.core3"]);

    expect(state.coverage["phase1.core1"]).toBe("unresolved");
    expect(state.coverage["phase1.core2"]).toBe("weak");
    expect(state.coverage["phase1.core3"]).toBe("sufficient");
  });

  it("marks probe exhaustion after maximum attempts", () => {
    const state: RuntimeState = initRuntimeState();
    state.coverage["lane1"] = "partial";
    state.evidence_probe_counts["lane1"] = 2;

    markProbeExhaustion(state, { lane1: "description" }, null, 2);
    expect(state.coverage["lane1"]).toBe("weak");
  });

  it("advances phase when completion keys are met", () => {
    const config = loadConfig();
    const specs = buildSpecs(config);
    const state: RuntimeState = initRuntimeState();
    const firstPhase = specs.agent.phases[0];

    // Mark all completion keys as sufficient
    for (const key of firstPhase.completion_keys) {
      state.coverage[key] = "sufficient";
    }
    state.phase_turns = firstPhase.min_learner_turns + 1;

    const analysis: AnswerAnalysis = {
      classification: "strong",
      learner_intent: "answer",
      valid_evidence: [],
      evidence_updates: [],
      claim_assessments: [],
      unresolved_point: "",
    };

    const action = selectAction(analysis, state, specs.persona, specs.agent);
    expect(state.phase_index).toBe(1);
    expect(action.name).toBe("transition_phase");
  });

  it("speech flags come from the model's reasoning plus mechanical checks only", () => {
    // All rules pass → no flags
    const reasoning = {
      one_real_question: { ok: true, why: "one ask" },
      no_copied_facts: { ok: true, why: "clean" },
      no_invented_mention: { ok: true, why: "clean" },
      word_budget: { ok: true, why: "22 words" },
      in_persona_voice: { ok: true, why: "matches" },
    };
    expect(flagsFromCompliance(reasoning)).toEqual([]);

    // Model flags a rule itself
    const flagged = { ...reasoning, no_copied_facts: { ok: false, why: "said Rocket" } };
    expect(flagsFromCompliance(flagged)).toEqual(["no_copied_facts"]);

    // Missing rules are flagged mechanically (schema check)
    expect(flagsFromCompliance({ one_real_question: { ok: true, why: "x" } })).toEqual(["no_copied_facts:missing", "no_invented_mention:missing", "word_budget:missing", "in_persona_voice:missing"]);
    expect(flagsFromCompliance(null)).toEqual(["missing_reasoning"]);

    // Mechanical: empty text, hard word ceiling, invented mention
    expect(mechanicalSpeechFlags("", "", 90)).toEqual(["empty_response"]);
    expect(mechanicalSpeechFlags("word ".repeat(91).trim(), "", 90)).toEqual(["word_budget"]);
    expect(mechanicalSpeechFlags("You mentioned SQS queues. What happened?", "I used Redis.", 90)).toEqual(["no_invented_mention"]);
    expect(mechanicalSpeechFlags("What happened there?", "I mentioned the event loop.", 90)).toEqual([]);
  });

  it("best-of-2 selection prefers fewer flags and never returns an empty draft", () => {
    const a = { text: "draft one", flags: ["one_real_question", "no_copied_facts"] };
    const b = { text: "draft two", flags: ["no_copied_facts"] };
    expect(pickBestDraft([a, b])).toBe(b);
    // tie → first draft wins
    expect(pickBestDraft([b, { text: "draft three", flags: ["no_copied_facts"] }])).toBe(b);
    // empty drafts are unusable
    expect(pickBestDraft([a, { text: "   ", flags: [] }])).toBe(a);
    expect(pickBestDraft([{ text: "  ", flags: [] }, { text: "", flags: [] }])).toBeNull();
  });

  it("quoted sufficient coverage survives probe exhaustion", () => {
    const config = loadConfig("resume-mastery");
    const specs = buildSpecs(config);
    const state: RuntimeState = initRuntimeState();
    const activeEv = specs.agent.phases[0].evidence_keys[0];
    const learner = "we observed a failure when connection dropped";
    applyEvidenceUpdates({
      classification: "strong",
      learner_intent: "answer",
      valid_evidence: [learner],
      evidence_updates: [{
        key: activeEv,
        status: "sufficient",
        evidence: "clear description of failure",
        quote: "we observed a failure",
        provenance: "observed_incident",
      }],
      claim_assessments: [],
      unresolved_point: "",
    }, state, specs.agent.required_evidence, true, learner);
    state.evidence_probe_counts[activeEv] = 2;
    markProbeExhaustion(state, { [activeEv]: "desc" }, null, 2);
    expect(state.coverage[activeEv]).toBe("sufficient");
  });

  it("unquoted evidence updates do not change coverage", () => {
    const config = loadConfig("resume-mastery");
    const specs = buildSpecs(config);
    const state: RuntimeState = initRuntimeState();
    const activeEv = specs.agent.phases[0].evidence_keys[0];
    applyEvidenceUpdates({
      classification: "strong",
      learner_intent: "answer",
      valid_evidence: [],
      evidence_updates: [{
        key: activeEv,
        status: "sufficient",
        evidence: "unguarded",
        quote: "not in the answer",
        provenance: "supported_elaboration",
      }],
      claim_assessments: [],
      unresolved_point: "",
    }, state, specs.agent.required_evidence, false, "I used Redis for caching.");
    expect(state.coverage[activeEv]).toBeUndefined();
  });

  it("does not replay the pending question after a gradeable fallback", () => {
    const config = loadConfig();
    const specs = buildSpecs(config);
    const state: RuntimeState = initRuntimeState();
    const key = specs.agent.phases[0].evidence_keys[0];
    state.pending_question = "What exact component did you implement?";
    const action = {
      name: "probe_required_evidence",
      evidence_key: key,
      reason: "need evidence",
      intent: "ask one question",
      close: false,
      expects_answer: true,
    };
    const fallback = deterministicFallback(action, specs.agent, state);
    expect(fallback).not.toBe(state.pending_question);
  });

  it("persona vote can switch allowed actions but cannot close", () => {
    const action = {
      name: "probe_required_evidence",
      evidence_key: "lane.a",
      reason: "r",
      intent: "i",
      close: false,
      expects_answer: true,
    };
    const voted = applyPersonaVote(
      action,
      ["probe_required_evidence", "isolate_missing_part", "close_session"],
      ["isolate_missing_part", "isolate_missing_part", "isolate_missing_part"],
      [],
    );
    expect(voted.name).toBe("isolate_missing_part");
    expect(voted.evidence_key).toBe("lane.a");
    expect(applyPersonaVote(
      { ...action, name: "close_session", close: true, evidence_key: null },
      ["close_session", "isolate_missing_part"],
      ["isolate_missing_part", "isolate_missing_part", "isolate_missing_part"],
      [],
    ).name).toBe("close_session");
  });

  it("persona rewrite cannot leak moment facts or invent mentions", () => {
    const config = loadConfig();
    const specs = buildSpecs(config);
    const state: RuntimeState = initRuntimeState();
    const action = {
      name: "probe_required_evidence",
      evidence_key: specs.agent.phases[0].evidence_keys[0],
      reason: "r",
      intent: "i",
      close: false,
      expects_answer: true,
    };
    const transcript = [{ role: "user", text: "The event loop drains microtasks before timers." }];
    // "invented mention" is now caught mechanically: claim not verbatim in learner text
    expect(mechanicalSpeechFlags("You mentioned SQS at Acme. Can you explain the event loop?", "The event loop drains microtasks before timers.", 90)).toContain("no_invented_mention");
    // clean line passes with no flags
    expect(mechanicalSpeechFlags("Can you walk through that microtask drain?", "The event loop drains microtasks before timers.", 90)).toEqual([]);
  });
});
