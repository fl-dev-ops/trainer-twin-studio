/**
 * Interview spec compiler.
 * Direct 1:1 port of build_specs from agent/interview.py.
 */

export type ClaimProvenance =
  | "context_declared"
  | "observed_incident"
  | "supported_elaboration"
  | "unverified_elaboration"
  | "hypothetical";

export type Classification =
  | "strong"
  | "partial"
  | "vague"
  | "unsupported"
  | "contradictory"
  | "unknown"
  | "role_violation";

export type ClaimHandling =
  | "resume_evidence"
  | "conceptual"
  | "hypothetical_design"
  | "coding_execution"
  | "session_feedback";

export interface PersonaSpec {
  id: string;
  name: string;
  version: number;
  style: Record<string, unknown>;
  decision_preferences: Record<string, string>;
  examples?: Record<string, string[]>;
  language?: Record<string, unknown>;
  calibration?: Record<string, unknown>;
  source_evidence?: Record<string, unknown>;
}

export interface PhaseSpec {
  id: string;
  name: string;
  objective: string;
  evidence_keys: string[];
  completion_keys: string[];
  min_learner_turns: number;
  max_learner_turns: number;
  opening: string;
  claim_handling?: ClaimHandling;
  context_mode?: string;
  context_required?: boolean;
  tools?: Array<string | Record<string, unknown>>;
  scenario?: Record<string, unknown>;
  knowledge_tags?: string[];
  maximum_topics?: number;
  retrieval?: boolean;
  allowed_actions: string[];
  default_action: string;
  max_probes_per_lane: number;
  rendering: Record<string, unknown>;
}

export interface AgentSpec {
  id: string;
  name: string;
  version: number;
  domain: string;
  objective: string;
  opening: string;
  phases: PhaseSpec[];
  claim_handling: ClaimHandling;
  context_mode: string;
  scenario: Record<string, unknown>;
  tools: Array<string | Record<string, unknown>>;
  required_evidence: Record<string, string>;
  allowed_actions: string[];
  default_action: string;
  max_learner_turns: number;
  rendering: Record<string, unknown>;
  knowledge_grounding: Array<Record<string, unknown>>;
  knowledge_query_guidance: string;
  completion: string;
}

export interface DomainSpec {
  id: string;
  name: string;
  version: number;
  knowledge_bases: string[];
  principles?: string[];
  classifications?: Record<string, string>;
}

export interface CompiledSpecs {
  persona: PersonaSpec;
  agent: AgentSpec;
  domain: DomainSpec;
  knowledgeBases: string[];
}

function deepMerge(base: Record<string, any>, override: Record<string, any>): Record<string, any> {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      result[key] &&
      typeof result[key] === "object" &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = structuredClone(value);
    }
  }
  return result;
}

export function buildSpecs(config: Record<string, any>): CompiledSpecs {
  const personaData = structuredClone(config.persona?.data ?? {});
  personaData.version = config.persona?.version ?? 1;
  const persona: PersonaSpec = {
    id: config.persona?.id ?? personaData.id,
    name: personaData.name,
    version: personaData.version,
    style: personaData.style ?? {},
    decision_preferences: personaData.decision_preferences ?? {},
    examples: personaData.examples ?? {},
    language: personaData.language ?? {},
    calibration: personaData.calibration ?? {},
    source_evidence: personaData.source_evidence ?? {},
  };

  const agentData = config.agent?.data ?? {};
  const defaults = agentData.config ?? {};
  const domainData = structuredClone(config.domain?.data ?? {});
  domainData.version = config.domain?.version ?? 1;

  const kbs = config.knowledgeBases ?? [];
  if (!Array.isArray(kbs) || !kbs.every((k) => typeof k === "string" && k.length > 0)) {
    throw new Error("knowledgeBases must be a list of indexed collection names");
  }
  domainData.knowledge_bases = kbs;

  const domain: DomainSpec = {
    id: domainData.id,
    name: domainData.name,
    version: domainData.version,
    knowledge_bases: kbs,
    principles: domainData.principles ?? [],
    classifications: domainData.classifications ?? {},
  };

  if (agentData.domain !== domain.id) {
    throw new Error("Agent's domain does not match supplied Domain");
  }

  const phases: PhaseSpec[] = [];
  const definitions: Record<string, string> = {};
  const seen = new Set<string>();

  for (const stage of agentData.stages ?? []) {
    const sid = stage.id;
    if (!sid || seen.has(sid)) {
      throw new Error(`Duplicate/empty stage id: ${sid}`);
    }
    seen.add(sid);

    const sc = stage.config ?? {};
    const merged = deepMerge(defaults, sc);
    const evidence = sc.evidence ?? {};
    const keys: string[] = evidence.keys ?? [];
    const completion: string[] = evidence.completion_keys ?? [];

    if (!keys.length || !completion.length || keys.length !== new Set(keys).size) {
      throw new Error(`Stage ${sid} requires unique evidence keys and completion keys`);
    }

    const keySet = new Set(keys);
    const defKeys = new Set(Object.keys(evidence.definitions ?? {}));
    if (!completion.every((k) => keySet.has(k)) || !keys.every((k) => defKeys.has(k))) {
      throw new Error(`Stage ${sid} references undefined evidence`);
    }

    const qualified = (k: string) => `${sid}.${k}`;
    for (const k of keys) {
      definitions[qualified(k)] = evidence.definitions[k];
    }

    const minimum = sc.turns?.minimum;
    const maximum = sc.turns?.maximum;
    if (
      typeof minimum !== "number" ||
      typeof maximum !== "number" ||
      minimum < 0 ||
      minimum > maximum ||
      maximum < 1
    ) {
      throw new Error(`Invalid turn bounds in ${sid}`);
    }

    const actions = merged.actions ?? {};
    const allowed: string[] = [...(actions.allowed ?? [])];
    if (!allowed.includes("close_session") && (defaults.actions?.allowed ?? []).includes("close_session")) {
      allowed.push("close_session");
    }
    if (!allowed.includes("transition_phase") && (defaults.actions?.allowed ?? []).includes("transition_phase")) {
      allowed.push("transition_phase");
    }
    if (!allowed.includes("present_feedback") && (defaults.actions?.allowed ?? []).includes("present_feedback")) {
      allowed.push("present_feedback");
    }
    if (
      !allowed.length ||
      !allowed.includes("close_session") ||
      !allowed.some((a) => a !== "close_session" && a !== "transition_phase")
    ) {
      throw new Error(`Stage ${sid} must allow conversation and closing`);
    }

    let defaultAction: string = actions.default;
    if (!allowed.includes(defaultAction)) {
      if (sc.actions && "default" in sc.actions) {
        throw new Error(`Stage ${sid} default action is not allowed`);
      }
      const fallback = allowed.find((a) => a !== "close_session" && a !== "transition_phase");
      if (!fallback) throw new Error(`Stage ${sid} has no valid default action`);
      defaultAction = fallback;
    }

    const rendering = merged.rendering ?? {};
    if (typeof rendering.maximum_words !== "number" || rendering.maximum_words < 10 || rendering.maximum_words > 200) {
      throw new Error("maximum_words must be 10–200");
    }
    if (
      typeof rendering.maximum_question_marks !== "number" ||
      rendering.maximum_question_marks < 0 ||
      rendering.maximum_question_marks > 3
    ) {
      throw new Error("maximum_question_marks must be 0–3");
    }

    if (Object.values(evidence.definitions ?? {}).some((v) => typeof v !== "string" || !v.trim())) {
      throw new Error("Evidence definitions must be nonempty text");
    }

    phases.push({
      id: sid,
      name: stage.name,
      objective: stage.objective,
      opening: (typeof stage.stage_brief === "string" && stage.stage_brief) || stage.opening,
      evidence_keys: keys.map(qualified),
      completion_keys: completion.map(qualified),
      min_learner_turns: minimum,
      max_learner_turns: maximum,
      claim_handling: merged.claim_handling,
      context_mode: merged.context?.mode,
      context_required: merged.context?.required ?? false,
      tools: merged.tools ?? [],
      scenario: merged.scenario ?? {},
      knowledge_tags: merged.knowledge?.tags ?? [],
      maximum_topics: merged.knowledge?.maximum_topics,
      retrieval: merged.knowledge?.retrieval !== "disabled",
      allowed_actions: allowed,
      default_action: defaultAction,
      max_probes_per_lane: actions.max_probes_per_lane ?? 2,
      rendering,
    });
  }

  if (!phases.length) {
    throw new Error("Agent requires at least one stage");
  }

  for (const phase of phases.slice(1)) {
    const entry = phase.claim_handling === "session_feedback" ? "present_feedback" : "transition_phase";
    if (!phase.allowed_actions.includes(entry)) {
      throw new Error(`Stage ${phase.id} must allow ${entry}`);
    }
  }

  const sessionMax = defaults.turns?.maximum;
  if (typeof sessionMax !== "number" || sessionMax < 1) {
    throw new Error("Session maximum turns must be a positive integer");
  }

  const agent: AgentSpec = {
    id: agentData.id,
    name: agentData.name,
    version: config.agent?.version ?? 1,
    domain: domain.id,
    objective: agentData.objective,
    opening: (typeof agentData.spoken_opening === "string" && agentData.spoken_opening) || agentData.opening,
    phases,
    claim_handling: defaults.claim_handling ?? "conceptual",
    context_mode: defaults.context?.mode ?? "none",
    scenario: defaults.scenario ?? {},
    tools: defaults.tools ?? [],
    required_evidence: definitions,
    allowed_actions: defaults.actions?.allowed ?? [],
    default_action: defaults.actions?.default ?? "probe_required_evidence",
    max_learner_turns: sessionMax,
    rendering: defaults.rendering ?? {},
    knowledge_grounding: agentData.knowledge_grounding ?? [],
    knowledge_query_guidance: agentData.objective,
    completion: "Configured completion keys or turn limits.",
  };

  return { persona, agent, domain, knowledgeBases: kbs };
}
