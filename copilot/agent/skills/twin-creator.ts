import { defineSkill } from "eve/skills";
import { TWIN, twinRequirementsText } from "../lib/twin-skill";

// The twin-skill procedure, plus the limits its tools enforce (built from the same constants as the checks).
const procedure = `# Build one twin skill

A twin skill is the trainer's **knowledge, decisions, patterns and approach on one topic**, taken from their own
material. The trainer's twin loads it to advise a learner on a real situation (a client, a deal, a call happening now),
the way the trainer would. **It is not a role play**: no practice script, no learner part to play, no roles, steps or
trainer/learner moves. If the request is for a practice session or something to rehearse, stop and use
\`roleplay-creator\` instead.

Do all the work yourself. Plan the whole run before reading anything.

1. **Understand the topic.** Restate it in one line, and name ${TWIN.situations.min} to ${TWIN.situations.max} situations a learner would bring about it
   (e.g. "the buyer wants to wait for prices to drop"). Write this to \`specs/<id>.md\`.
2. **Find the trainer's material.** Call \`files\`, then at most 3 \`search\` calls. Pick at least 3 sources where the
   trainer explains, decides or handles this topic: coaching sessions, solo lessons, method docs, posts. In a two-person
   recording, note which speaker label is the trainer.
3. **Read once.** One \`read\` of the parts that matter. Collect the trainer's own words for every situation, with about
   20% to spare. Never take a learner's or client's words as the trainer's.
4. **Prepare everything, then build.** Write the items (each: situation, kind, context), \`patterns\` (the evidence notes,
   citing [[file#turn]]), and the SKILL.md \`body\` in the first person, as the trainer:
   - **Topic**: what this covers and the situations.
   - **What I know**: facts and principles the trainer states.
   - **How I decide**: "when …, I … because …".
   - **Patterns I see**: what recurring situations usually mean.
   - **My approach**: how the trainer handles it, as a way of working, not a script.
   - **What I say**: how the trainer phrases things.
   - **Gaps**: what the material does not cover.
   Then call \`build_twin_skill\` once.
5. **Fix, don't restart.** It returns the rejected items or the check reasons. Fix every listed reason in the next call,
   all at once. At most 3 \`build_twin_skill\` calls. If the third still fails, write \`report.md\` with the open reasons and
   stop without publishing.
6. **Finish.** When the check passes, write \`report.md\` and call \`publish_twin_skill\`. It becomes a skill of the
   trainer's twin.

If fewer than 3 sources show the trainer's thinking on this topic, report that and stop. Never invent what the trainer
knows, decides or says, and never expose personal details.
`;

export default defineSkill({
  description:
    "Build one twin skill: the trainer's knowledge, decisions, patterns and approach on one topic, which their twin uses to advise learners. Use for a twin, twin skill, 'my approach' or 'how I handle X' request. Never a role play.",
  markdown: `${procedure}\n${twinRequirementsText()}`,
});
