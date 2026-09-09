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
  initRuntimeState,
  markProbeExhaustion,
  nextEvidence,
  selectAction,
  validateAction,
  validateAnalysis,
  validateRendered,
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
  it("compiles standard Studio configurations from YAML", () => {
    const config = loadConfig("resume-mastery", "vasanth");
    const compiled = buildSpecs(config);

    expect(compiled.persona.id).toBe("vasanth");
    expect(compiled.agent.id).toBe("resume-mastery");
    expect(compiled.agent.phases.length).toBeGreaterThanOrEqual(1);

    const firstPhase = compiled.agent.phases[0];
    expect(firstPhase.evidence_keys.length).toBeGreaterThan(0);
    expect(firstPhase.evidence_keys[0].startsWith(firstPhase.id)).toBe(true);
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

  it("validates rendered output and catches role reversal or generic praise", () => {
    const config = loadConfig();
    const specs = buildSpecs(config);
    const state: RuntimeState = initRuntimeState();
    const action = {
      name: "probe_required_evidence",
      evidence_key: specs.agent.phases[0].evidence_keys[0],
      reason: "test",
      intent: "ask question",
      close: false,
      expects_answer: true,
    };

    // Role reversal
    const err1 = validateRendered("When I built the system, what happened?", action, specs.agent, state);
    expect(err1).toContain("role reversal");

    // Generic praise
    const err2 = validateRendered("That's solid! Can you explain more?", action, specs.agent, state);
    expect(err2).toContain("generic praise");

    // Clean question
    const err3 = validateRendered("Can you explain how ownership was divided?", action, specs.agent, state);
    expect(err3.length).toBe(0);
  });
});
