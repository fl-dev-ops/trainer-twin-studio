import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { specDraftBundleSchema, type SpecDraftBundle } from "@/lib/spec-draft-schema";

const OPENROUTER_BASE_URL = (process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
const MODEL = process.env.SPEC_GENERATION_MODEL ?? "google/gemini-2.5-flash";

export type GenerationInput = {
  slug: string;
  instruction: string;
  name: string;
  opening: string;
  personaName?: string;
  knowledgeBase?: string;
  previous: { instruction?: string; agent: unknown; domain: unknown } | null;
};

// Loose JSON schema: it guarantees parseable JSON from the model; the zod
// bundle schema below enforces every field contract after the fact.
const ACTION_LIST = "ask_exact_example, ask_reflection, ask_reflective_walkthrough, close_session, deepen_with_edge_case, deepen_with_tradeoff, isolate_missing_part, narrow_hint, present_coding_problem, present_feedback, probe_required_evidence, redirect_role, request_code, request_justification, request_revision, reveal_requirement, run_code, scaffold_missing_link, surface_contradiction, transition_phase";

const responseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["agent", "domain", "grounding", "assumptions"],
  properties: {
    agent: {
      type: "object",
      additionalProperties: false,
      required: ["id", "name", "version", "domain", "objective", "opening", "config", "stages"],
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        version: { type: "integer" },
        domain: { type: "string" },
        objective: { type: "string", description: "One-sentence overall objective of the scenario." },
        opening: { type: "string" },
        config: {
          type: "object",
          additionalProperties: false,
          required: ["claim_handling", "context", "scenario", "tools", "actions", "evidence", "turns", "rendering"],
          properties: {
            claim_handling: { type: "string", enum: ["resume_evidence", "conceptual", "hypothetical_design", "coding_execution", "session_feedback"] },
            context: {
              type: "object", additionalProperties: false, required: ["mode", "required"],
              properties: {
                mode: { type: "string", enum: ["none", "resume_grounding", "resume_topics_only", "scenario_only", "session_evidence"] },
                required: { type: "boolean", description: "True only when the scenario cannot run without the learner's document." },
              },
            },
            scenario: { type: "object", additionalProperties: false, description: "Empty object unless the trainer defines a simulated environment." },
            tools: { type: "array", items: { type: "string", enum: ["coding_sandbox"] }, description: "Empty unless the trainer asked for coding exercises." },
            actions: {
              type: "object", additionalProperties: false, required: ["allowed", "default"],
              properties: {
                allowed: { type: "array", minItems: 2, items: { type: "string", enum: ACTION_LIST.split(", ") }, description: "Must include close_session and at least one conversational action." },
                default: { type: "string", description: "One of allowed." },
              },
            },
            evidence: {
              type: "object", additionalProperties: false, required: ["statuses"],
              properties: { statuses: { type: "array", minItems: 5, items: { type: "string", enum: ["untested", "partial", "sufficient", "weak", "unresolved"] } } },
            },
            turns: {
              type: "object", additionalProperties: false, required: ["maximum"],
              properties: { maximum: { type: "integer", description: "Total learner-turn budget, typically 8-24." } },
            },
            rendering: {
              type: "object", additionalProperties: false,
              required: ["maximum_words", "maximum_question_marks", "one_focal_ask", "deterministic_closing"],
              properties: {
                maximum_words: { type: "integer" },
                maximum_question_marks: { type: "integer" },
                one_focal_ask: { type: "boolean" },
                deterministic_closing: { type: "boolean" },
              },
            },
          },
        },
        stages: {
          type: "array", minItems: 1,
          items: {
            type: "object", additionalProperties: false,
            required: ["id", "name", "objective", "opening", "config"],
            properties: {
              id: { type: "string", description: "Unique kebab-case stage id." },
              name: { type: "string" },
              objective: { type: "string" },
              opening: { type: "string" },
              config: {
                type: "object", additionalProperties: false,
                required: ["knowledge", "claim_handling", "context", "evidence", "turns"],
                properties: {
                  knowledge: {
                    type: "object", additionalProperties: false, required: ["tags"],
                    properties: { tags: { type: "array", items: { type: "string" }, description: "Topical retrieval tags." } },
                  },
                  claim_handling: { type: "string", enum: ["resume_evidence", "conceptual", "hypothetical_design", "coding_execution", "session_feedback"] },
                  context: {
                    type: "object", additionalProperties: false, required: ["mode"],
                    properties: { mode: { type: "string", enum: ["none", "resume_grounding", "resume_topics_only", "scenario_only", "session_evidence"] }, required: { type: "boolean" } },
                  },
                  evidence: {
                    type: "object", additionalProperties: false, required: ["definitions", "keys", "completion_keys"],
                    properties: {
                      definitions: { type: "object", additionalProperties: { type: "string" }, description: "Map of kebab-case key -> one-sentence definition of what counts as evidence." },
                      keys: { type: "array", items: { type: "string" }, description: "Subset of definition keys." },
                      completion_keys: { type: "array", items: { type: "string" }, description: "Subset of keys that must be sufficient before the stage ends." },
                    },
                  },
                  turns: {
                    type: "object", additionalProperties: false, required: ["minimum", "maximum"],
                    properties: { minimum: { type: "integer" }, maximum: { type: "integer" } },
                  },
                  actions: {
                    type: "object", additionalProperties: false, required: ["allowed"],
                    properties: {
                      allowed: { type: "array", minItems: 2, items: { type: "string", enum: ACTION_LIST.split(", ") } },
                      default: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    domain: {
      type: "object",
      additionalProperties: false,
      required: ["id", "name", "version", "knowledge_bases", "principles", "classifications"],
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        version: { type: "integer" },
        knowledge_bases: { type: "array", items: { type: "string" } },
        principles: { type: "array", minItems: 3, maxItems: 6, items: { type: "string" } },
        classifications: {
          type: "object", additionalProperties: { type: "string" },
          required: ["strong", "partial", "vague", "unsupported", "contradictory", "unknown", "role_violation"],
          description: "Exactly these seven keys, each with a one-sentence meaning.",
        },
      },
    },
    grounding: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["knowledgeBase", "source", "stageIds", "purpose", "queryGuidance", "tags"],
        properties: {
          knowledgeBase: { type: "string" },
          source: { type: "string" },
          stageIds: { type: "array", items: { type: "string" } },
          purpose: { type: "string" },
          queryGuidance: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
        },
      },
    },
    assumptions: { type: "array", items: { type: "string" } },
  },
} as const;

const SYSTEM_PROMPT = `You compile TrainerTwin interview scenarios. The trainer gives requirements in plain language; you return one JSON bundle containing an Agent spec, a Domain spec, and knowledge grounding records. The deterministic voice runtime executes the Agent spec literally — it never improvises. Encode everything the trainer asked for into spec fields; do not leave requirements only implied.

## Output contract
Return ONLY a JSON object with keys: agent, domain, grounding, assumptions.
- agent.id / agent.name: echo the provided slug and name unchanged. agent.opening: echo the provided first message unchanged.
- domain: the assessment rules for this scenario's subject area. Use the provided domain id.
- grounding: one record per attached knowledge base (knowledgeBase, source, stageIds, purpose, queryGuidance, tags). Empty array when no knowledge base is attached.
- assumptions: 1-5 short statements of decisions you made that the trainer should review.

## Agent spec rules
- config.claim_handling (choose one): resume_evidence | conceptual | hypothetical_design | coding_execution | session_feedback
- config.context.mode (choose one): none | resume_grounding | resume_topics_only | scenario_only | session_evidence. Set config.context.required=true only when the scenario cannot run without the learner's document (e.g. a resume deep-dive).
- config.actions.allowed must be a subset of: ask_exact_example, ask_reflection, ask_reflective_walkthrough, close_session, deepen_with_edge_case, deepen_with_tradeoff, isolate_missing_part, narrow_hint, present_coding_problem, present_feedback, probe_required_evidence, redirect_role, request_code, request_justification, request_revision, reveal_requirement, run_code, scaffold_missing_link, surface_contradiction, transition_phase. It must include close_session plus at least one conversational action, and config.actions.default must be one of allowed.
- config.evidence.statuses: ["untested", "partial", "sufficient", "weak", "unresolved"]
- config.turns.maximum: total learner turns budget (typically 8-24).
- config.rendering: maximum_words 10-200 (voice answers stay short, ~45), maximum_question_marks 0-3 (typically 1), one_focal_ask true, deterministic_closing true.
- stages: 1-4 phases. Each stage has unique kebab-case id, name, objective, opening, and config:
  - stage.config.knowledge.tags: topical retrieval tags.
  - stage.config.claim_handling and stage.config.context.mode: like above.
  - stage.config.evidence: definitions (map of kebab-case key -> one-sentence definition of what counts as evidence), keys (subset of definitions), completion_keys (subset of keys that must be sufficient before the stage ends).
  - stage.config.turns: {minimum, maximum} per stage, minimum <= maximum.
  - stage.config.actions: optional narrower allowed/default subset.
  - stage.config.tools: [] unless the scenario explicitly needs the coding sandbox.
  - stage.config.scenario: {} unless the trainer defines a simulated environment.
- Everything the trainer's instruction requires must be expressible through stages, evidence keys, and actions. If the instruction names topics or behaviors, they appear as evidence keys, knowledge tags, or stage objectives — never as prose only.

## Domain spec rules
- principles: 3-6 assessment principles as one-sentence rules.
- classifications: exactly these keys, each with a one-sentence meaning: strong, partial, vague, unsupported, contradictory, unknown, role_violation.

## Style rules
- Behavior lives in the spec; persona tone comes from the runtime persona, not the agent spec.
- Technical truth comes from the attached knowledge, never invented by the spec.
- Conceptual and hypothetical reasoning counts as valid evidence unless the trainer says otherwise.
- Respect the previous spec when iterating: keep its structure and evidence keys unless the new instruction requires changing them.`;

async function referenceExample(): Promise<string> {
  // A real published bundle grounds the format; fall back to prompt-only if missing.
  try {
    const [agentRaw, domainRaw] = await Promise.all([
      fs.readFile(path.join(process.cwd(), "data/agents/resume-mastery.yaml"), "utf8"),
      fs.readFile(path.join(process.cwd(), "data/domains/software-engineering-resume.yaml"), "utf8"),
    ]);
    const agent = (yaml.load(agentRaw) as { agent: unknown }).agent;
    const domain = (yaml.load(domainRaw) as { domain: unknown }).domain;
    return `## Format reference (real published bundle, abbreviated)\nAgent:\n${yaml.dump(agent, { lineWidth: 100 })}\nDomain:\n${yaml.dump(domain, { lineWidth: 100 })}\n`;
  } catch {
    return "";
  }
}

async function callModel(messages: { role: string; content: string }[]): Promise<unknown> {
  const key = process.env.OPENROUTER_API_KEY ?? process.env.LLM_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is not set");
  const res = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages,
      response_format: { type: "json_schema", json_schema: { name: "spec_bundle", strict: true, schema: responseSchema } },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Spec generation request failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const content: string | undefined = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("Spec generation returned no content");
  return JSON.parse(content);
}

/** Generates a validated Agent+Domain bundle from the trainer's instruction. */
export async function generateSpecBundle(input: GenerationInput): Promise<SpecDraftBundle> {
  const userLines = [
    `Scenario slug: ${input.slug}`,
    `Scenario name: ${input.name}`,
    `First message: ${input.opening}`,
    input.personaName ? `Persona (behavior is handled by the runtime, not the spec): ${input.personaName}` : "",
    input.knowledgeBase ? `Attached knowledge base (all grounding must reference it): ${input.knowledgeBase}` : "No knowledge base attached: grounding must be empty.",
    "",
    "## Trainer requirements",
    input.instruction,
  ];
  if (input.previous) {
    userLines.push(
      "",
      "## Previous version (iterate from this; keep structure and evidence keys unless the instruction requires a change)",
      input.previous.instruction ? `Previous instruction:\n${input.previous.instruction}\n` : "",
      yaml.dump({ agent: input.previous.agent, domain: input.previous.domain }, { lineWidth: 100, noRefs: true }),
    );
  }

  const system = SYSTEM_PROMPT + "\n\n" + (await referenceExample());
  const messages: { role: string; content: string }[] = [
    { role: "system", content: system },
    { role: "user", content: userLines.join("\n") },
  ];

  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    let parsed: unknown;
    try {
      parsed = await callModel(messages);
    } catch (error) {
      lastError = error;
      continue;
    }
    const result = specDraftBundleSchema.safeParse({ ...(parsed as object), slug: input.slug, name: input.name, gaps: [] });
    if (result.success) return result.data;
    lastError = result.error;
    messages.push({
      role: "user",
      content: `Your previous JSON failed validation with these errors. Return the corrected full JSON object only:\n${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n")}`,
    });
  }
  throw new Error(
    `Spec generation failed after retry: ${lastError instanceof Error ? lastError.message.slice(0, 500) : "unknown error"}`,
  );
}
