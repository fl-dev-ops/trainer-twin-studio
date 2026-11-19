import { defineSkill } from "eve/skills";
import { requirementsText } from "../lib/ingest";

// The role-play procedure, plus the limits its tools enforce (built from the same constants as the checks), so the
// agent knows every limit before its first build. Loaded only for a role play; a twin skill is a different product.
const fromRequirements = `# Write a role play from the trainer's requirements

Use this when the trainer describes the practice they want (in the chat, a document or an attachment). A role play is
one brief: the AI's instructions for this situation, written to "you", plus lines it can look up. It is played by one
persona from the Persona Library, which gives the voice and personality.

0. **Check what exists.** Call \`list_roleplays\`. When a role play for this same practice and persona already exists,
   this is a change to it: \`get_roleplay\` it and keep its brief id, so publishing makes its next version. Never create
   a second one for the same practice, and never archive anything unless the trainer asks. When the trainer gives the
   requirements again, rewrite the brief from them (same id): keep earlier content only where the requirements
   support it, and drop details they don't.
1. **Read everything first.** The trainer's message and every attachment. Find, for this one role play: who the AI
   plays, who the learner plays, the situation, what the learner should achieve, how it starts, how it goes, how the AI
   reacts, how it ends, and any lines the trainer gave (objections, questions, sample lines).
2. **Ask once, only for what is missing and essential**: who the AI plays, who the learner plays, the situation, what the
   learner should achieve. Ask them together in one short message. Everything else, propose yourself and say it is a
   proposal. Never ask about things you can sensibly propose.
3. **Pick the persona.** Call \`list_personas\` and choose the one that fits the AI's role. If none fits, say which
   persona to create (name, role, a line of personality) in Personas, and stop until it exists.
4. **Say plainly what this role play cannot do yet**, when the requirements ask for it: several personas in one call or
   a persona picked at random per session (offer one role play per persona instead), modes such as practice vs mock
   (offer one role play per mode), and scoring, reports or feedback (not part of the role play). Never fake them in the
   brief.
5. **Write the brief** (\`draft_roleplay\`). Quality rules:
   - Write to the AI as "you". Short, concrete sentences; no lists of adjectives.
   - \`ai.who\` and \`situation\` are what is happening NOW: what triggered the call, what you know and don't know, how
     you feel at the start, facts to keep consistent. Personality and speaking style belong to the persona, not here.
   - \`concerns\`: what this person worries about, as they would put it, with when it comes up and what eases it. Mark
     the ones they keep to themselves as hidden. Never write the answers.
   - \`steps\`: 2 to 6, a real conversation, not a checklist; include moments the AI brings in on purpose.
   - \`reactions\`: observable things the learner does. Resistance is reasonable and firm, not hostile; difficulty
     comes from stakes, not rudeness.
   - \`ending\`: a limit (time or count), what good looks like, and the exit line if the AI ends it.
   - \`learnerBrief\`: written to the learner: who they are, the situation, the outcome to aim for, the limit. Never the
     hidden concerns.
   - \`items\`: only lines the trainer gave (objection lists, question banks, sample lines), each with kind, when it
     fits and tags. Never invent lines. With items, write \`itemsGuide\`.
   - In an interview, exam or assessment the AI asks and probes; it never teaches, hints or nudges toward the answer
     unless the requirements ask for coaching during the call.
   - Keep the trainer's own words for facts, lines and rules; don't embellish. Use only this persona's and this
     scenario's details: never borrow another persona's backstory or another scenario's facts from the same document. Never add names,
     people, dates or numbers the requirements don't give: refer to others by role ("a teammate who left"). Fictional names and numbers from the
     requirements stay as they are; never add real people's personal details.
   Fix every reason \`draft_roleplay\` returns in the next call, all at once; at most 3 drafts.
6. **Show the trainer, in your reply,** once a draft passes: the learner brief and a short summary (the AI's role and
   persona, the situation, the steps, how it ends) and which values you proposed rather than took from them; then ask
   whether to publish or change something. Never end a turn on a tool call without this reply. Change it by chat as
   they ask.
7. **Publish** with \`publish_roleplay\` (they approve it on a card), then reply with what the studio stored: the role
   play's name, slug and version, or its error.
   A family of scenarios is one role play each: write and publish them one at a time, keeping shared parts identical.

To **change** a role play written this way (\`get_roleplay\` shows kind \`roleplay-brief\` and its \`brief\`): edit only
what was asked in that brief, keep its id, draft, show what changed, publish. It becomes the next version.
`;

const procedure = `# Build one role play from recordings

Use this only when the trainer asks for a role play built from their recordings (sessions where they run that
practice with a learner). It is not a twin skill: if the request is about the trainer's knowledge, decisions or approach on a topic,
stop and use \`twin-creator\` instead.

Do all the work yourself. Plan the whole run before reading anything.

1. **Understand the requirement.** Restate it in one line: the practice, the trainer part and the learner part. Write it to \`specs/<id>.md\`. Note the minimums under "Requirements".
2. **Find sessions.** Call \`files\`, then at most 2 \`search\` calls. Pick at least 3 two-person recordings that show this practice, not just its topic.
3. **Read once.** One \`read\` with \`files\`: the practice span of each chosen session. Read enough turns to collect the item minimums with about 20% to spare. A second read only for a session that turned out too thin.
4. **Prepare everything, then build.** Write the plan, \`patterns\`, all items, \`skill\` and \`body\` against the requirements. Then call \`build_scenario\` once.
5. **Fix, don't restart.** \`build_scenario\` returns the rejected items or the check reasons.
   - Drop a rejected item when you still meet the minimums without it. Re-read a turn only to fix exact \`start\`/\`end\` words.
   - Fix every listed reason in the next call, all at once.
   - At most 3 \`build_scenario\` calls. If the third still fails, write \`report.md\` with the open reasons, publish, and stop.
6. **Finish.** When the check passes, write \`report.md\` and call \`publish\`. It is stored as a role play.

If fewer than 3 sessions show the practice, say so and offer to write it from their requirements instead (above). Never invent lines or expose personal details.

\`write\` can only create \`specs/<id>.md\` and \`report.md\`. Never use it for \`patterns.md\`, \`SKILL.md\`, \`scenario.json\` or \`items.json\`; \`build_scenario\` creates all of those.

# Change an existing role play

Check \`list_roleplays\` first; never create a second role play for the same practice.
- **Builder role play** (\`roleplay-builder\`): change its fields, Settings or Tools with \`update_roleplay\` (the trainer
  approves the card). Read it with \`get_roleplay\` first and change only what was asked.
- **Role play built from recordings** (\`roleplay-recordings\`): \`load_skill\` writes the published version to
  \`baseline/<slug>/\`. Rebuild with the same scenario id, starting from its plan, steps and items: keep what still holds,
  add the new sessions or method docs, and tell the trainer what changed before \`publish\` (approved on a card). It
  becomes the next version; the previous one is kept.
`;

export default defineSkill({
  description:
    "Write or change one role play (a practice session the AI leads, e.g. a client call, a mock interview, a difficult conversation): from the trainer's requirements, or from their recordings. Use for a role-play, practice, rehearsal or mock-interview request, never for a twin skill.",
  content: `${fromRequirements}\n${procedure}\n${requirementsText()}`,
});
