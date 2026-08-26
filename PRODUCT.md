# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Domain trainers, including technical interview trainers, who want to turn their expertise and source material into reusable conversational training agents without authoring implementation schemas.

## Product Purpose

TrainerTwin helps a trainer upload authoritative knowledge, describe the trainer or interview they want in conversation, and produce grounded Agent and Domain specifications that can be reviewed, tested, versioned, and published for voice sessions.

Success means a trainer can move from source material and a plain-language request such as “I want an agent for React mock interviews” to a validated, knowledge-grounded published trainer without understanding TrainerTwin's internal YAML schema.

## Positioning

Conversation is the primary control surface; Agent, Domain, and knowledge-policy specifications are compiled, inspectable artifacts. TrainerTwin links each trainer decision to authoritative knowledge and executes published specifications through a deterministic interview runtime rather than allowing an LLM to improvise the whole workflow.

## Operating Context

A new trainer typically uploads documents into a knowledge base, asks the Copilot to create an agent, answers focused follow-up questions, reviews the evolving blueprint and source grounding, and publishes when ready. Published agents are then used in voice interview or training sessions. Draft and published history must remain available to the Copilot.

## Capabilities and Constraints

- Knowledge ingestion and hybrid retrieval use the existing Chroma/OpenRouter pipeline.
- The Copilot creates Agent and Domain specs; it reuses an existing Persona until Persona onboarding is designed separately.
- A Persona is a reusable, versioned trainer-style profile, not a singleton and not copied into every Agent. A trainer or organization may choose a default Persona and attach it to many Agents.
- Published Agents pin a Persona version. Stage-specific pacing, probing, evidence, and completion remain Agent policy; a materially different teaching or interviewing style should create or fork a Persona.
- Persona cloning may use behavioral examples but never technical knowledge as evidence of personality.
- Working drafts are overwritten continuously while revisions remain recoverable.
- Published versions are immutable and used by the Pipecat/deterministic runtime.
- Publishing requires deterministic validation, a visible change summary, and explicit human approval.
- PostgreSQL is authoritative; Eve state is conversation working memory only.
- The Copilot receives narrow TrainerTwin tools, never unrestricted shell, filesystem, or arbitrary web access.
- Knowledge references must describe where and how material is used, not merely attach a knowledge base globally.

## Evidence on Hand

- Existing canonical Persona, Agent, and Domain YAML files under `web/data/`.
- Existing TypeScript knowledge ingestion and retrieval in `web/lib/knowledge.ts`.
- Existing Pipecat voice runtime in `agent/` and deterministic policy/runtime in `synthesizer/poc/`.
- Existing TrainerTwin studio, spec version history, knowledge manager, and interview sessions in `web/`.

## Product Principles

- Start from the trainer's desired outcome, not the internal schema.
- Ask only the next highest-value missing question.
- Make grounding, assumptions, gaps, and runtime impact visible.
- Keep drafts easy to change and publishing deliberate.
- Let session and simulation evidence feed future trainer improvements.

## Accessibility & Inclusion

The core creation workflow must remain keyboard accessible, screen-reader understandable, responsive, and usable without voice input.
