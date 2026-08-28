# Digital twin platform information architecture

**Started:** 2026-08-28
**Last session:** 2026-08-28

## The idea (raw, first pass)
Voice, persona, and knowledge base feel like modules of their own, while the role-play (agent) is a bounded scenario that ties all of those modules together so they work coherently. The product should be considered as a digital twin platform rather than being tightly coupled to a trainer/learner use case.

## The idea (current articulation)
The platform has reusable resources, bounded scenarios, and runtime history. Personas, voices, and knowledge are independently managed resources; Persona remains the right user-facing name because it can evolve from behavioral datasets such as past conversations. A Scenario composes those resources into a bounded experience, while Sessions show what happened at runtime. The organization-aware Copilot is a cross-cutting assistant and should be available contextually across the product, with its full-page route retained for deep work.

## What we've dug into
- How should independent modules be grouped? → Separate reusable resources from compositions and runtime activity.
- Should Persona and Role Play share a library? → No. Persona is identity; Role Play is orchestration. Grouping them obscures their relationship.
- Is Voice Cloning a module? → No. It is a creation action inside the Voices module.
- What should be central in a generic digital twin platform? → Reusable Personas and bounded Scenarios can express the model without prematurely introducing “Twin” as another user-facing object.
- Should Copilot be renamed Agent? → No. “Agent” implies the autonomous/deployed object and creates taxonomy ambiguity; Copilot or Assistant better describes a singular supporting capability.
- Should Copilot remain only a destination? → No. Its organization-wide context makes it a better global contextual panel, while the existing route remains useful as an expanded workspace.

## Lenses applied
- Abstraction laddering — separated raw resources, stable identity, bounded behavior, and runtime instances.
- Product ontology — distinguished nouns that persist from actions that create them and executions that produce history.

## Reference points discussed
- Unity/Unreal — reusable assets are composed into scenes; scenes are what run.
- ElevenLabs agent products — voices remain reusable assets while agents compose voice, instructions, knowledge, and tools.
- Figma — reusable components are maintained independently, but the primary work object is the composed file, not a list of implementation primitives.

## Open questions / unknowns
- Whether “Scenario” or “Role Play” should be the first-market label; Scenario is the stronger platform-level concept.
- Whether Copilot should keep its current name or eventually become the more neutral “Assistant.”
- Which knowledge is stable across a Persona and which is intentionally scoped to one Scenario.

## Session log
### 2026-08-28
Established a resource → twin → scenario → run mental model. The recommended near-term IA is a hybrid: Twins and Scenarios as primary work objects, Voices and Knowledge as reusable library resources, Sessions as runtime history, and Copilot as a cross-cutting creation surface rather than another content module.

Refined the model after deciding Persona is meaningful as an evolving behavioral resource built from conversation datasets. Landed on a simpler visible IA: Workspace (Sessions, Scenarios), Library (Personas, Voices, Knowledge), and Organization (Users), with Copilot moved to a global right-side panel and its full-page route retained as an expanded mode.
