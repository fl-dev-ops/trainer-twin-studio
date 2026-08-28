# Twin platform module grouping

**Started:** 2026-08-28
**Last session:** 2026-08-28

## The idea (raw, first pass)
"Voice, persona, knowledge base are modules of their own, whereas the role-play (agent) is a bounded scenario — the one that ties all modules together to work coherently. Want to break/group things this way on a digital twin platform, without tightly coupling to the trainer/learner use case."

## The idea (current articulation)
A digital twin = Persona + Voice + Knowledge (a reusable simulated person). A Role Play = a bounded composition that references twins by ID and owns scenario-specific behavior (phases, coverage). Sessions = read-only runs of a role play. Group nav by ontology (Library / Scenarios / Activity), not by workflow stage.

## What we've dug into
- Two Voice nav entries → resolved: cloning is a verb, not a noun; one Voice module, clone action inside it (ElevenLabs precedent)
- Module litmus test: own lifecycle + ≥2 consumers
- Domain → demoted to a role-play field until it has a second consumer
- Persona vs role-play boundary: identity lives in persona; scenario behavior lives in role play ("would this sentence survive if the scenario changed?")

## Lenses applied
- Primitives vs compositions (Unix, Zapier, GPTs, Vapi/Retell) — validated the module/scenario split as the convergent industry shape
- Ontology over workflow grouping — Library/Scenarios/Activity nav

## Reference points discussed
- ElevenLabs — one voice library, cloning as an in-module action
- Vapi/Retell — Assistant composes voice/knowledge/number primitives
- Twilio vs early chatbot platforms — clean primitive layer enabled pivoting the composition layer without rewriting assets

## Open questions / unknowns
- Voice ↔ Persona binding: does a twin own a default voice, or does the role play pick the voice?
- Migration path from current nav/schema (domainSlug, spec tables) to this IA
- Whether Copilot stays in Workspace or becomes a composition consumer of twins too

## Session log
### 2026-08-28
First session. User proposed modules (voice/persona/knowledge) + role play as the tying composition. Reviewed learner-facing UX, admin nav, and schema; resolved the Voices/Voice-Cloning duplication, defined the litmus test for nav entries, proposed Library/Scenarios/Activity IA, and set persona/role-play boundary rules. Left open: voice↔persona binding and migration plan.
