# Vasanth interview roleplays: Phase 2 decision inventory

Inspected **19 November 2026**, local source database `trainertwin`, organization `careerwithvasanth`. **Inventory only; no conversion or new interview format is proposed here.** Phase 1 remains the separate Olga local-only port; stop before implementing Vasanth Phase 2.

## Scope and safety

- Source connection: `postgresql://surya@localhost:5432/trainertwin?host=/tmp&options=-c%20default_transaction_read_only%3Don`.
- Every successful inventory batch asserted `current_database()='trainertwin'`, `default_transaction_read_only='on'`, and `transaction_read_only='on'` using a SELECT and psql `\if` before its inventory SELECTs. Final guard returned `trainertwin / on / on`. The first attempted CASE-based guard failed because PostgreSQL constant-folded its `1/0` error branch; no inventory query in that batch ran. Subsequent guards used the boolean assertion instead.
- Only SELECT SQL; no application execution, migrations, data writes, production calls, AWS access, credential reads, Chroma access/provisioning, pushes, or commits. Only this Markdown file was written.
- No learner transcripts, resume text, claim text, report prose, learner identities, emails, credentials, private persona examples, full prompts, or object keys are reproduced. Session and learner-document references below are aggregates only.
- Code references below are relative to the **legacy source checkout `../application/`**, not the destination `application-v3`.

## What actually exists

**10 active, public `ROLEPLAY` agents: nine focused interviews and one full mock named “Internal Testing.”** All belong to this organization and reference its own persona **`Vasanth` v19**, `isOwn=true`. Their data has **no `skill`, `source`, or artifact package fields**; there are also zero `SkillSource` and zero `AgentSkillVersion` rows for this organization.

These are **interviewer-led `roleplay-interview` sessions**, not `roleplay-client` simulations. `chat/agent/lib/roleplay.ts:24–37` requires `kind=ROLEPLAY` **and a string `data.skill`** for client mode; `session-mode.ts:20–24` otherwise falls back to interview mode. “ROLEPLAY” alone does not mean the AI plays a customer.

### Current ten-record table

Version is the authoritative **Agent row version**; embedded `data.version` is shown separately because it is often stale. Question figures are authored quotas, **not question-bank inventory or guaranteed delivered totals**. Follow-ups are the maximum **per main question**. Stage bounds and the session cap can shorten delivery.

| Agent slug — current display name | Row / JSON v | Stages | Claim handling / context mode; upload required | Main-question configuration; follow-ups | Session turn cap |
|---|---:|---:|---|---|---:|
| `project-experience-deep-dive` — Project & Experience Deep Dive | 4 / 2 | 1 | `resume_evidence` / `resume_grounding`; yes | resume: 4; 2 each | 12 |
| `impact-quantification` — Impact & Quantification | 10 / 9 | 1 | `resume_evidence` / `resume_topics_only`; yes | resume: 4; 2 each | 12 |
| `resume-defense-cross-examination` — Resume Defense & Cross-Examination | 4 / 2 | 1 | `resume_evidence` / `resume_grounding`; yes | resume: 4; 2 each | 16 |
| `fundamental-knowledge` — Fundamental Knowledge | 4 / 2 | 1 | `conceptual` / `resume_topics_only`; no | technical: verbal 2, MCQ 1, code-output 2 = 5; 2 each; 26 topics | 12 |
| `conceptual-understanding` — Conceptual Understanding | 19 / 16 | 1 | `conceptual` / `none`; no | technical: verbal 2, MCQ 1, coding 2 = 5; 3 each; 26 topics | 12 |
| `depth-reasoning-application` — Depth & Application | 3 / 2 | 1 | `conceptual` / `resume_topics_only`; no | technical: verbal 2, MCQ 1, coding 1, code-output 1, system-design 1 = 6; 1 each; 31 topics | 12 |
| `problem-understanding-requirements` — Problem Understanding & Requirements | 5 / 2 | 1 | `hypothetical_design` / `scenario_only`; no | technical: system-design 1; 7 each; topic `system-design` | 12 |
| `system-design-solution-development` — System Design & Solution | 13 / 10 | 1 | `hypothetical_design` / `scenario_only`; no | technical: system-design 1; 7 each; topic `system-design` | 12 |
| `scale-tradeoffs-evolution` — Scale, Trade-offs & Evolution | 4 / 2 | 1 | `hypothetical_design` / `scenario_only`; no | technical: system-design 1; 7 each; **0 topics** | 12 |
| `full-mock-interview` — Internal Testing | 1 / 1 | 5 | top-level `conceptual` / `none`; no; stage overrides below | technical: verbal 2, coding 1, system-design 1 = 4; 1 each; 5 topics | 42 |

All seven technical records' selected topic slugs resolve to approved local `Topic` rows; Scale's empty set is not an approved selection. No configured `machine-coding` questions exist. Full mock topics: `system-design`, `coding-problems`, `react`, `javascript-runtime`, `distributed-systems`. Fundamentals and Conceptual share 26 JavaScript/browser/React/performance topics; Depth has 31 spanning performance, architecture, reliability, distributed systems, coding, JavaScript and React.

## Stored authoring structure

### Prompts and media, without private prompt bodies

Lengths are PostgreSQL `length(text)` in **characters**, not bytes or tokens. Principles show item count / sum of item text lengths, excluding JSON punctuation. Every listed opening is nonempty. No current stage has `stage_brief`; no current agent has `spoken_opening`.

| Slug | Instruction chars | Principles count / chars | Agent opening chars | Stage opening chars, in order | Intro reference |
|---|---:|---:|---:|---|---|
| `project-experience-deep-dive` | 1,324 | 6 / 371 | 47 | 101 | present |
| `impact-quantification` | 1,386 | 5 / 449 | 53 | 109 | present |
| `resume-defense-cross-examination` | 1,602 | 6 / 397 | 53 | 109 | present |
| `fundamental-knowledge` | 1,056 | 5 / 478 | 47 | 143 | present |
| `conceptual-understanding` | 1,030 | 5 / 478 | 47 | 149 | present |
| `depth-reasoning-application` | 1,033 | 5 / 478 | 47 | 172 | present |
| `problem-understanding-requirements` | 1,155 | 5 / 444 | 47 | 198 | present |
| `system-design-solution-development` | 680 | 5 / 444 | 47 | 98 | present |
| `scale-tradeoffs-evolution` | 1,325 | 5 / 444 | 47 | 121 | present |
| `full-mock-interview` | absent | 2 / 198 | 87 | 93, 109, 101, 108, 89 | absent |

- All ten legacy `data.voiceId` values match the linked persona's voice. Persona owns a **cloned, ready voice**, with audio and transcript references, plus an avatar with an image reference; no original-image or avatar-video reference. No media bytes or remote object existence were checked.
- Persona `settings` is null: no explicit program-settings override. Persona row v19 has embedded JSON v1; its data sections are `style`, `decision_preferences`, `examples`, `language`, `calibration`, and `source_evidence`, alongside identity/version. Style has `tone`, `avoid`, `habits`. This is behavioral source material, not just a display name.
- Nine intro strings are nonempty references. The source resolves HTTP URLs directly or presigns stored S3 keys (`web/lib/specs.ts:254–272`). These are **scenario intros**, distinct from the persona avatar and runtime warm openings.
- All ten deployments are active and allow `chat,voice`; “Internal Testing” is the stored name, **not a private visibility restriction**.

### Stages and evidence

Each focused interview has one stage. Below, evidence counts are **all keys / completion keys**. Completion is a selected subset, not a second rubric. Definitions are nonempty authored text stored with the keys.

| Agent | Exact stage ID — name | Stage min–max turns | Evidence / completion | Evidence themes |
|---|---|---:|---:|---|
| Project | `project-deep-dive` — Project & Experience Deep Dive | 6–10 | 9 / 5 | problem, personal ownership, contribution, mechanism, decision reasoning; also challenges, alternatives, individual/team split, outcome |
| Impact | `quantified-impact-validation` — Quantified Impact Validation | 6–10 | 9 / 5 | causal link, time period, measurement method, baseline, business/engineering impact; also confidence, scope, metric source, other factors |
| Resume Defense | `resume-cross-examination` — Resume Cross-Examination | 8–12 | 9 / 4 | ownership, technical depth, decisions, impact justification; also consistency, alternatives, scale, explanation simplicity, learning |
| Fundamentals | `fundamental-knowledge` — Fundamental Knowledge | 6–12 | 6 / 3 | explanation, mechanism walkthrough, concrete example; also terminology, breadth, follow-up correctness |
| Conceptual | `conceptual-understanding` — Conceptual Understanding | 6–10 | 5 / 4 | internal mechanism, reasoning, scenario behavior, trade-off; also edge case |
| Depth | `depth-reasoning-application` — Depth & Application | 6–10 | 8 / 5 | debugging, first principles, applied solution, limitations, revision; also bottleneck, integration, honest depth boundary |
| Requirements | `problem-understanding-requirements` — Problem Understanding & Requirements | 6–10 | 6 / 5 | clarification, functional/nonfunctional requirements, assumptions, scope; also decomposition |
| System Design | `system-design-solution-development` — System Design & Solution | 6–10 | 6 / 5 | architecture, end-to-end flow, reliability/security, technology reasoning, coherence; also interface/storage |
| Scale | `scale-tradeoffs-evolution` — Scale, Trade-offs & Evolution | 6–10 | 7 / 5 | what fails first, bottleneck diagnosis, adaptation, recovery, trade-offs; also prioritization, revisiting decisions |

Full mock's **ordered five stages**:

| Stage ID — name | Min–max | Claim handling / context | Evidence / completion; special settings |
|---|---:|---|---|
| `resume` — Resume Deep Dive | 4–7 | `resume_evidence` / `resume_grounding`, required | 6 / 5: problem, ownership, contribution, mechanism, outcome, measurement |
| `technical` — Technical Fundamentals & Depth | 5–8 | `conceptual` / `resume_topics_only` | 6 / 5: foundations, mechanism, scenario, trade-off, application, limitation; resume/topic intersection, max 2 topics |
| `coding` — Coding & Problem Solving | 6–10 | `coding_execution` / `session_evidence` | 7 / 6: clarification, approach, correctness, execution, complexity, tests, revision |
| `system-design` — System Design | 6–10 | `hypothetical_design` / `scenario_only` | 7 / 6: clarification, requirements, architecture, flow, bottleneck, recovery, adaptation; reveal requested facts only; source priority Notion → generated from Notion topics → platform default |
| `feedback` — Feedback Exchange | 1–2 | `session_feedback` / `session_evidence` | 4 / 4: strengths, priority gaps, recommendations, reflection; retrieval disabled |

### Classification, actions, probes and tools

- Nine focused agents store seven answer classifications: `strong`, `partial`, `vague`, `unsupported`, `contradictory`, `unknown`, `role_violation`. Impact has metric-specific definitions; the other eight share definitions. Full mock has no top-level `classifications` object.
- All ten configure evidence statuses `untested`, `partial`, `sufficient`, `weak`, `unresolved`. These are different from answer classifications, report scores and claim provenance.
- All default to `probe_required_evidence`. The full mock explicitly sets `max_probes_per_lane=2`; the nine focused agents omit it, and the compiler defaults to 2. This lane limit is **not** the authored per-question follow-up quota.
- Common action vocabulary includes exact examples, reflection, justification, missing-part isolation, contradiction, edge cases, trade-offs, probing and closing. Differences matter:
  - Project, Fundamentals, Requirements and Scale share stage actions including `reveal_requirement` and `narrow_hint`; top-level lists also contain `transition_phase`.
  - Conceptual adds `ask_reflective_walkthrough` but not `reveal_requirement` or `transition_phase`.
  - System Design adds `ask_reflective_walkthrough` and `reveal_requirement`, but no `transition_phase`.
  - Impact has a narrower eight-action list: probe, justify, isolate, contradict, edge case, reflect, close, narrow hint.
  - Resume Defense includes `request_revision` and `transition_phase`, but no narrow hint or reveal requirement.
  - Depth includes `present_coding_problem`, `request_code`, `run_code`, `present_mcq`; no transition action.
  - Full mock includes phase transition, feedback, revision, role redirection and scaffolding; coding and feedback stages narrow their action lists.
- Every top-level **`config.tools` is an empty array**. Full mock coding stage alone declares `coding_sandbox`, candidate-choice language, network disabled, 256 MB, 10-second timeout. A declaration is not proof those execution limits are enforced.
- **Separate workspace policy:** all ten lack top-level `data.tools`, and have resume/technical interview config with no skill. Consequently legacy policy enables canvas, code editor, preview and choice (`chat/agent/lib/agent-tools.ts:14–28`); empty `config.tools` does **not** mean the UI tools are disabled.
- All render settings: maximum 45 words, one focal ask, maximum one question mark, deterministic closing.

## Knowledge and resume grounding

### Knowledge references and inventory

- Nine focused records each have `knowledgeBase="acme-knowledge"`, `knowledge_bases=["acme-knowledge"]`, and one `knowledge_grounding` entry with a stage ID, tags, source label, purpose and query guidance. These refer to the organization's own KB, not another organization's same-named KB.
- Full mock has **none of those three fields**; its stage knowledge tags still exist. **This does not imply zero runtime knowledge:** `web/lib/specs.ts:670–690` falls back to all indexed KBs in the org when no selection is stored. Chat context independently offers the org's indexed `acme-knowledge` (`session-context.ts:47–54,145`).
- Organization KB **Acme Knowledge / `acme-knowledge`**: **38 documents, all 38 indexed, all Markdown**, total recorded source size **220,482 bytes**, 38 markdown references, **0 `s3QuestionsKey` references**. One active `notion_public` knowledge source.
- Grounding themes: Project—resume/architecture/project depth; Impact—metrics/causality/measurement; Defense—claim verification/decisions/scalability; Fundamentals—JavaScript/browser/React/networking; Conceptual—runtime/async/React internals; Depth—debugging/performance; Requirements—scope/constraints; Design—architecture/data flow/storage/security; Scale—failure/consistency/monitoring/cost.
- Stored grounding tags and stage tags are not always aligned: Fundamentals, Depth, Requirements and Scale retain generic stage tags `resume,architecture,project-depth` while their grounding entries are specialized. Technical `topic_slugs` are a third, separate selection.
- **Unknown:** actual vector chunks, available question counts/types, question-bank completeness, remote object availability, and live Notion sync health. Zero question-file references does **not** prove an empty Chroma question bank. No Chroma or S3 calls were made.

### Resume claims are learner/session data, not authored scenario content

- Upload ingestion schedules claim extraction (`web/lib/uploads.ts`, `resume-claims.ts:132–216,250`). Existing per-document claims are reused; text/anchors come from the uploaded resume, not a scenario's authored question list.
- Resume config selects a primary session document, then eligible `project`, `experience`, `impact`, `architecture`, `technology` claims with nonempty anchors. Previously consumed claims are excluded using completed `start_resume_question` workspace commands (`resume-interview.ts:5–54`). Highlighting and question start therefore depend on document IDs, claims, anchors and workspace state—not only prompt text.
- Chat context returns eligible claims and extracted resume data for an attached document (`session-context.ts:87–121`); server runtime also has stored-claim selection/fallback paths (`runtime/openai.ts:692–776`). These are separate implementations to preserve or intentionally replace later.
- Local session references point to **one distinct primary document**, also one distinct document in the session-document relation, with **23 claims**: experience 12, technology 6, architecture 2, project 2, impact 1. No document names, claim bodies, anchors or learner identifiers were read into this report.
- Impact requires an upload but declares `resume_topics_only` while its claim handling is `resume_evidence`. Full mock top-level upload is optional, while its first stage requires resume grounding. These are real stored inconsistencies, not silently normalized here.
- Impact's authored upload guidance includes a session-only/deletion assurance. This inventory did not verify retention enforcement; do not repeat that promise in a new UI without a separate retention review.

## Stored configuration is not the whole behavior

| Layer | Source evidence | Why Phase 2 must decide separately |
|---|---|---|
| Authoring/history | `web/lib/pages/spec-resource.ts:60–145`; `specs.ts:291–303,354+`; `spec-generation.ts`; `spec-drafts.ts` | Editor works with instruction, opening, persona, KB, voice, interview settings and YAML; changed saves snapshot the prior spec. Drafts can overlay the current editor view. Copying the published row alone does not preserve authoring history. |
| Server compiler/runtime | `web/lib/runtime/compiler.ts:125–309`; `runtime/openai.ts`; `runtime/runtime.ts` | Merges stage defaults, validates bounds/actions, qualifies evidence keys, controls turns/probes and question selection. It compiles principles but **does not map `instruction` into `AgentSpec`**. For technical interviews it deliberately clears authored stage evidence/completion keys; resume interviews retain them. |
| Chat interview runtime | `chat/agent/lib/compose-instructions.ts:24–30`; `brain.ts:340–390,665–701`; `session-plan.ts:74–144,215+` | Uses frozen base interview instructions plus raw instruction/spec, persona, evidence rules, agenda, documents and tools. Its plan retains stage evidence and distributes the global question sequence across stages **round-robin**, rather than inferring question type from stage names. Follow-up/unknown-answer rules and closing confirmation are code behavior. |
| Knowledge availability | `web/lib/specs.ts:670–690`; `session-context.ts`; `question-bank.ts:18–38,131+` | KB attachment, all-org fallback, shared chat KB, selected topics and typed question-bank records are distinct. DB indexed status is not a runnable question inventory test. |
| Reports/scoring | `web/lib/session-after.ts:7–10`; `generate-session-report.ts:36–54,60–114`; `session-report-grounding.ts`; `session-report.ts:30–41` | These ten lack `after` settings, so route to the existing **session report**, not twin or client-rubric report. Uses transcript + evidence + compiled objective/phases/criteria; returns summary/tags/key moments/next focus and optional holistic 0–100 score. It is not a deterministic sum of evidence statuses. |

Compiler validation requires technical interviews to have both runtime-resolved KBs and nonempty selected topics (`compiler.ts:283–285`). Thus **Scale's current empty topics fail this compiler check**. Full mock's missing stored KB can be satisfied by org fallback, so it should not be labeled a guaranteed missing-KB failure.

Full mock deserves an explicit behavior decision: its top-level technical quotas total **four main questions across five stages**, while names imply resume → technical → coding → design → feedback. The chat planner distributes those four typed questions round-robin across the five stages; stage names do not establish appropriate per-stage question quotas. Separately, server technical compilation discards its authored evidence completion keys. No end-to-end execution was performed to claim how well this internal test works.

Report grounding uses the server compiler, and catches incompatible historical snapshots, retaining recorded evidence if compilation fails. Technical reports therefore need not receive the authored evidence-key rubric that chat displays. Current reports must not be relabeled as new client-roleplay rubric scores.

## History and session references — aggregates only

| Agent | Historical SpecVersion rows / versions | Current row version |
|---|---|---:|
| Project | 3 / 1–3 | 4 |
| Impact | 9 / 1–9 | 10 |
| Resume Defense | 3 / 1–3 | 4 |
| Fundamentals | 3 / 1–3 | 4 |
| Conceptual | 16 / 2–17 | 19 |
| Depth | 2 / 1–2 | 3 |
| Requirements | 4 / 1–4 | 5 |
| System Design | 12 / 1–12 | 13 |
| Scale | 3 / 1–3 | 4 |
| Full mock | 0 | 1 |

- **55 historical agent snapshots**, dated 12–21 September 2026. All have one stage, instruction and grounding; none has a skill. Instruction lengths vary historically for Impact (979–1,386), Depth (1,033–1,127) and System Design (680–1,055); other ranges equal current lengths.
- Conceptual's available history omits v1 and v18. Do not infer missing snapshots from stale JSON versions or manufacture them.
- Older snapshots often have **no `config.interview`**: Project and Defense have none in any stored historical snapshot; the other seven have a mix of absent and current interview-type settings. Claim modes are stable across available snapshots; Conceptual context changes between `resume_topics_only` and `none`. Historical specs cannot be assumed to have current quota behavior.
- Persona: **18 historical snapshots v1–18**, current row v19, dated 11 September 2026. **22 persona sources**, all analyzed transcripts; source bodies and analyses were not copied.
- Five published authoring drafts: Project revision 2 / 1 saved prior revision; Impact 9 / 8; Defense 2 / 1; Conceptual 12 / 11; System Design 9 / 8. All link `Vasanth`; **29 draft-revision rows** total. These are published drafts, not five unpublished scenarios.
- **Five local InterviewSession rows**, all Resume Defense **agent v4 / persona v19**, all **voice**, all with compiled snapshots and a primary context: four completed with completed reports, one abandoned with report status `none`. The other nine agents have no local session rows. This is not a production usage census.

## Phase 2 user decision checklist

### Storage/content decisions — what should be kept?

- [ ] Keep all nine focused interviews? Retain, rename, hide or exclude the public “Internal Testing” full mock?
- [ ] Preserve current published specs only, or also 55 prior agent snapshots, 18 persona snapshots, five published drafts and 29 draft revisions? Keep authoritative row versions separate from stale embedded versions.
- [ ] Preserve private instructions, principles, openings, stage definitions, evidence definitions and grounding guidance in approved local storage—not in this public structural inventory?
- [ ] Retain the linked own persona and its behavioral sections, 22 source references, cloned voice, avatar and nine intros? Decide media transfer separately from metadata; no remote bytes are verified.
- [ ] Retain the 38-document org KB and Notion source relationship? Decide whether question-bank inventory needs its own read-only audit before any conversion.
- [ ] Keep learner resumes, claims, sessions and reports **out of the authored-content port** unless separately authorized; decide retention and historical snapshot compatibility independently.

### Behavior/product decisions — what should still work?

- [ ] Keep interviewer-led mode; do **not** convert these to client roleplays merely because their database kind is `ROLEPLAY`.
- [ ] Which existing runtime behavior is the preservation baseline: server compiler/runtime, chat interview runtime, or an explicitly chosen combination? They differ on instruction consumption, technical evidence and multi-stage planning.
- [ ] Preserve exact quotas, per-question follow-ups, stage/session bounds, probe limits, unknown-answer handling and closing confirmation? Which limits should take precedence when quotas exceed turn budgets?
- [ ] Keep resume-claim extraction, highlighting, used-claim tracking, code execution, MCQ choice and whiteboard/preview surfaces? Approve actual tool capabilities separately from authored action names.
- [ ] Resolve Scale's empty topics, full mock's global-quota/stage mismatch, optional-vs-required resume settings, and grounding/tag differences **before** calling any converted result behavior-equivalent.
- [ ] Keep org-wide knowledge fallback, or require explicit KB selection? Confirm typed question availability without provisioning or mutation.
- [ ] Keep the existing evidence-grounded session report and optional holistic score, or choose different evaluation behavior later? Do not invent a client rubric or deterministic score during storage work.

**Stop point:** no Vasanth conversion, schema, interview format, application change or data migration has been implemented. The checklist is for the user's Phase 2 choice, not an implementation approval.
