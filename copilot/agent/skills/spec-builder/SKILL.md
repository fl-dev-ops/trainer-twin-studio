---
description: Design, revise, critique, ground, or prepare publication of TrainerTwin Persona, Agent, and Domain specifications. Load this whenever a trainer wants to create or materially change a trainer, interview, curriculum, stages, evidence criteria, assessment policy, or completion behavior—even when they describe the need without mentioning specs.
metadata:
  provenance: "synthesizer requirement, interview policy, POC use cases, tests, and acceptance contract"
  version: "2"
---

# TrainerTwin spec-building method

Build an executable evidence strategy, not a list of plausible questions. The central design loop is:

```text
trainer outcome + authoritative sources
→ observable evidence
→ answer classifications
→ deterministic policy moves
→ constrained trainer behavior
→ completion criteria
```

A good specification explains what the learner must demonstrate, how the system distinguishes strong from incomplete evidence, what it does next, when it moves on, and which source supports each assessment decision.

## Keep ownership boundaries clean

- **Persona** controls reusable communication behavior: tone, habits, prohibited behaviors, and classification-to-action preferences.
- **Agent** controls the session: stages, evidence lanes, probing, hints, transitions, rendering, and completion.
- **Domain** controls assessment meaning: principles and answer classifications.
- **Knowledge** supplies assessor references. It does not establish trainer personality or learner truth.
- **Context** supplies session-specific claims or scenario state under the active stage's claim policy.

Do not copy the same policy into multiple concerns. Select an existing Persona by behavioral fit. Technical source material is not evidence of personality.

## Discovery workflow

1. Inspect studio inventory and the closest existing Agent and Domain before drafting.
2. Establish the trainer's desired learner outcome, audience, and session constraint.
3. Infer a provisional stage and evidence map from the request and sources.
4. Ask only the next decision that would materially change that map. Speak in trainer language, not schema field names.
5. Search the selected knowledge bases to verify stage coverage. Use at most three focused search rounds before recording a source gap.
6. Save a coherent baseline early, then revise the persisted artifact as decisions change.

Do not ask the trainer to design the schema. Offer a sensible default when the available evidence supports one, label the assumption, and ask for correction.

## Compile the Domain first

Define how answers will be judged before defining questions.

Domain principles should state durable assessment rules, such as:

- distinguish untested evidence from weak evidence;
- judge substance rather than confidence, grammar, accent, or verbosity;
- do not treat a plausible claim as verified fact;
- accept correct hypotheticals in conceptual or design stages;
- do not infer personality or hiring suitability from session evidence.

Classifications must describe answer states that can drive policy. Prefer the established vocabulary represented by existing Domain specs, including strong, partial, vague, unsupported, contradictory, unknown, and role violation where relevant.

A classification is not an evidence lane. “Partial” describes the latest answer; `personal_ownership` describes something the session is trying to establish.

## Design observable evidence

For each stage, define evidence lanes that an assessor could recognize in an answer or artifact.

Good evidence definitions are specific:

- `personal_ownership`: responsibility personally held, distinguished from team work;
- `internal_mechanism`: how and why the concept behaves internally;
- `measurement_method`: how the claimed result was measured under comparable conditions;
- `adaptation_tradeoff`: benefit and cost of changing the design under a new constraint.

Weak definitions merely repeat topics:

- “understands React”;
- “knows system design”;
- “answered the question well.”

Use these state meanings when designing criteria:

| State | Meaning |
|---|---|
| `untested` | No meaningful question or evidence yet. |
| `partial` | Relevant evidence is present but misses part of the definition. |
| `sufficient` | The exact interview criterion was demonstrated; factual truth is not implied. |
| `weak` | The lane was adequately probed but remained unsupported. |
| `unresolved` | A required lane was not reached before expiry. |

Keep completion keys smaller than the full evidence set. Include only evidence required to fulfill the stage objective; optional depth must not block progression.

For each proposed completion key, ask:

> If this remains untested, can the trainer honestly say the stage objective was met?

If yes, it is optional rather than a completion key.

## Build progressive stages

Stages should form an investigation, not a questionnaire. Each stage needs one coherent objective and evidence progression.

A useful progression is:

```text
establish foundation → examine mechanism → test application or adaptation
```

Use established patterns when they match the trainer's goal:

### Resume evidence

- Establish problem, personal ownership, concrete contribution, mechanism, reasoning, and outcome.
- Treat resume statements as declared claims, never proof.
- Separate personal scope from team scope.
- Require historical incidents only when evaluating an explicitly historical challenge or failure.
- Evaluate metrics through baseline, result, method, scope, causality, confounders, and calibrated confidence.

### Conceptual depth

- Move from explanation to internal mechanism, prediction, edge case, application, and trade-off.
- Definitions alone are partial.
- Correct hypotheticals count as conceptual evidence.
- Do not demand production incidents by default.
- Keep one concept coherent across increasing depth instead of hopping between trivia.

### Hypothetical system design

- First establish clarifications, functional requirements, nonfunctional requirements, assumptions, and scope.
- Then assess architecture, flow, reliability or security, and technology reasoning.
- Finally introduce a constraint and assess bottleneck diagnosis, adaptation, recovery, and trade-offs.
- Candidate designs are hypothetical by definition; never request personal historical proof.

### Coding execution

- Establish clarification and approach before implementation.
- Treat execution and tests as primary correctness evidence.
- Include `coding_sandbox` only when code will actually be executed.
- Assess complexity, test selection, and justified revision after failure or a changed constraint.

### Evidence-grounded feedback

- Derive feedback only from persisted session evidence.
- Separate observed strengths, unresolved gaps, and reflection.
- Never invent a hiring recommendation, personality judgment, or unsupported learner fact.

For a mixed interview, make claim handling and context mode explicit per stage so resume, conceptual, coding, design, and feedback rules do not leak into one another.

## Encode deterministic policy

The Agent should support predictable responses to answer states:

| Answer state | Preferred move |
|---|---|
| Strong | Deepen once with mechanism, edge case, or trade-off; then cover the next core lane. |
| Partial | Accept only the valid part and isolate one missing element. |
| Vague | Ask for one exact mechanism, decision, or example. |
| Unsupported | Ask for mode-appropriate evidence or justification. |
| Contradictory | Neutrally place both claims together and ask for reconciliation. |
| Unknown | Give one narrow non-answering hint when permitted, then move on. |
| Role violation | Restore roles and repeat the pending focal ask. |

Contradiction outranks depth. Transition outranks speculative follow-up. Closing outranks all follow-up when the budget is exhausted.

Use only canonical action identifiers accepted by the draft schema. A stage can narrow the global allowed actions, but its default must be allowed. Retrieval belongs in stage knowledge and grounding records, never in the Agent tool list.

## Set budgets and completion deliberately

- Give each stage minimum and maximum learner-turn budgets.
- Minimum turns prevent shallow accidental completion.
- Maximum turns prevent a stuck lane from consuming the session.
- Keep the global maximum consistent with the intended stage budgets.
- Use a bounded probe policy; after repeated failure, record the gap and move rather than rephrasing forever.
- Transitions should connect the completed investigation to the next objective.
- Closing should mention no more than three human-readable core gaps and contain no new question.

Do not optimize budgets to false precision. Use a reasonable default, label it as an assumption, and let the trainer adjust duration in ordinary language.

## Ground assessment decisions

For every stage, record:

- selected knowledge base;
- exact source or document when known;
- purpose of the source in that stage;
- focused retrieval guidance;
- tags that match the material actually retrieved.

Search for the evidence needed to assess the stage, not merely the stage title. For example, a React depth stage may need material covering reconciliation, effects, dependency behavior, cleanup, and failure modes—not just a document containing “React.”

Never invent a citation or source-backed criterion. When source coverage is missing:

1. preserve the useful ungrounded design as an explicit assumption when safe;
2. add a precise gap naming what source material is needed;
3. do not imply publication readiness.

## Adversarially review the design

Before saving a materially changed baseline, mentally run these learner variants through it:

- **Articulate but shallow:** Does fluent terminology pass without mechanism or evidence?
- **Hands-on but inarticulate:** Does the rubric recognize concrete evidence despite poor presentation?
- **Inflated ownership:** Can the policy distinguish “we” from personal contribution?
- **Honest limited ownership:** Does the design avoid punishing truthful scope boundaries?
- **Narrow expert:** Can one strong area coexist with unresolved broader evidence?
- **Evasive or defensive:** Do bounded probes prevent a stuck loop?
- **Self-correcting:** Can revision improve evidence rather than preserving an earlier weak judgment?
- **Contradictory:** Does reconciliation take precedence over moving deeper?

If the behavior would be wrong, fix the evidence definition, stage completion set, action policy, or claim handling—not the wording of one example question.

## Draft bundle shape

`save_spec_draft` validates against the canonical schema and returns exact errors; its schema is authoritative.
Use these exact field names and enum values when composing a draft:

```yaml
slug: my-agent              # must equal agent.id
name: My Agent
personaSlug: vasanth        # optional; existing Persona slug
agent:
  id: my-agent
  name: My Agent
  version: 1
  domain: my-domain         # must equal domain.id
  objective: …
  opening: …                # first interviewer turn text
  config:
    claim_handling: conceptual   # resume_evidence | conceptual | hypothetical_design | coding_execution | session_feedback
    context:
      mode: none            # none | resume_grounding | resume_topics_only | scenario_only | session_evidence
      required: false
      available_sources: [] # optional
    scenario: {}            # arbitrary key-value facts for hypothetical_design
    tools: []               # only "coding_sandbox" or {id: coding_sandbox, network: disabled,
                            # timeout_seconds, memory_mb, language}; never knowledge retrieval
    actions:
      allowed: [probe_required_evidence, transition_phase, close_session]
      default: probe_required_evidence   # must appear in allowed
      max_probes_per_lane: 3             # optional
    evidence:
      statuses: [untested, partial, sufficient, weak, unresolved]
    turns:
      maximum: 18
    rendering:
      maximum_words: 45
      maximum_question_marks: 1
      one_focal_ask: true
      deterministic_closing: true
  stages:
    - id: establish-foundation    # unique, stable objective
      name: …
      objective: …
      opening: …
      config:
        knowledge:
          tags: [react]           # must match retrieved material
          selection: adaptive_seniority   # optional; adaptive_seniority | resume_topic_intersection
          retrieval: enabled      # optional; enabled | disabled
          maximum_topics: 3       # optional
        claim_handling: conceptual
        context: {mode: none}
        evidence:
          definitions:            # every key needs an observable definition
            internal_mechanism: How and why the concept behaves internally.
          keys: [internal_mechanism]
          completion_keys: [internal_mechanism]   # subset of definitions; required only
        turns: {minimum: 3, maximum: 5}          # minimum ≤ maximum
        # actions / tools / scenario: omit unless this stage overrides
        # the agent-level default; if present, a stage default action must be allowed
domain:
  id: my-domain
  name: …
  version: 1
  knowledge_bases: [my-kb]
  principles: […]
  classifications:             # answer states that drive policy
    strong: …
    partial: …
    vague: …
    unsupported: …
    contradictory: …
    unknown: …
    role_violation: …
grounding:                    # at least one record
  - knowledgeBase: my-kb      # must appear in domain.knowledge_bases
    source: …
    documentId: …             # optional
    stageIds: [establish-foundation]   # must reference existing stages
    purpose: …
    queryGuidance: …          # natural-language retrieval instructions live here
    tags: [react]
assumptions: []
gaps: []
```

Canonical action identifiers (never invent aliases such as `ask_question`, `probe`, or `wrap_up`):

```text
ask_exact_example        ask_reflection          ask_reflective_walkthrough
close_session            deepen_with_edge_case   deepen_with_tradeoff
isolate_missing_part     narrow_hint             present_coding_problem
present_feedback         probe_required_evidence redirect_role
request_code             request_justification   request_revision
reveal_requirement       run_code                scaffold_missing_link
surface_contradiction    transition_phase
```

## Hard checks before save

Verify all of the following:

- Agent ID, draft slug, Domain reference, and Domain ID agree.
- Stage IDs are unique and express stable objectives.
- Every evidence key has an observable definition.
- Completion keys are a subset of stage evidence and contain only required criteria.
- Minimum turns do not exceed maximum turns.
- The global budget is plausible for the stage budgets.
- Defaults are included in allowed actions.
- Context and claim handling match the stage's epistemic mode.
- Coding tools appear only in coding-execution stages.
- Stage knowledge tags and grounding records reflect sources actually found.
- Every grounding stage ID and knowledge base exists in the bundle.
- Rendering preserves one focal ask and deterministic closing.
- Assumptions are explicit and gaps are actionable.
- No technical source was used to infer Persona behavior.

A structurally valid bundle can still be a poor trainer. Do not save disconnected stages, generic evidence labels, duplicated policy, ornamental configuration, or criteria unsupported by either trainer intent or authoritative material.

## Save and communicate

A specification exists only after `save_spec_draft` succeeds. Save the artifact instead of pasting full YAML into chat.

After saving, finish the turn's task state before replying. Keep todo item wording and order stable, update their statuses rather than replacing the list, mark completed work as completed, leave trainer-dependent next steps pending, and never park the session with a task still marked in progress.

Then report only:

1. what changed in trainer language;
2. what evidence or source justified it;
3. assumptions and gaps;
4. the next highest-value decision.

When that decision needs the trainer's answer, use `ask_question` and wait. Never ask in prose and continue executing tools in the same turn. Do not claim readiness or publication until the corresponding deterministic tool succeeds and the trainer approves it.
