import { defineSkill } from "eve/skills";
import { requirementsText } from "../lib/ingest";

// The role-play procedure, plus the limits its tools enforce (built from the same constants as the checks), so the
// agent knows every limit before its first build. Loaded only for a role play; a twin skill is a different product.
const fromRequirements = `# Write a role play from the trainer's requirements

Use this when the trainer describes the practice they want (in the chat, a document or an attachment). A role play is
a **stage** plus one **character** per persona:
- The stage is one brief, written to "you": the situation every persona shares, who speaks first, how the
  conversation goes and ends, rules, and lines it can look up. It never names or describes one persona.
- Each persona that plays it (Persona Library: name, voice, photo) has its own character for this role play only:
  who they are here, their facts, what they want, their concerns (and which they hide), their opening line, how they
  react and talk, and which ending they accept. No other role play sees it.
Every session plays one persona's character on the stage; a persona without a character is never picked.

0. **Check what exists.** Call \`roleplay_list\`. When a role play for this same practice and persona already exists,
   this is a change to it: \`roleplay_read\` it and keep its brief id, so publishing makes its next version. Never create
   a second one for the same practice, and never archive anything unless the trainer asks. When the trainer gives the
   requirements again, rewrite the brief from them (same id): keep earlier content only where the requirements
   support it, and drop details they don't.
1. **Read everything first.** The trainer's message and every attachment. Find, for this one role play: who the AI
   plays, who the learner plays, the situation, what the learner should achieve, how it starts, how it goes, how the AI
   reacts, how it ends, and any lines the trainer gave (objections, questions, sample lines).
2. **Ask once, only for what is missing and essential**: who the AI plays, who the learner plays, the situation, what the
   learner should achieve. Ask them together in one short message. Everything else, propose yourself and say it is a
   proposal. Never ask about things you can sensibly propose.
3. **Pick the persona.** Call \`persona_list\` and choose the one that fits the AI's role. If none fits, propose a new
   one (name, role, a few sentences of stable personality written to "you", and a voice from \`voice_list\`) and
   create it with \`persona_create\` once the trainer agrees (or adjust a close one with \`persona_update\`, if no other role play relies on how it is now). Stable personality goes in the persona; this situation in the brief; who
   they are in it, in their character. When the requirements describe several people for the same practice (a library
   of buyers), they are several personas of one role play, each with its own character, not one role play each.
   Several scenarios with the same people (a first call and a later meeting) are one role play per scenario, each with
   the same personas and a separate character per persona written for that scenario.
4. **Say plainly what this role play cannot do yet**, when the requirements ask for it: several personas in one call
   (a persona picked at random per session is supported, each with its own character: step 8), modes such as practice vs mock
   (offer one role play per mode), and scoring, reports or feedback (not part of the role play). Never fake them in the
   brief.
5. **Write the brief** (\`roleplay_draft\`). Quality rules:
   - Write to the AI as "you". Short, concrete sentences; no lists of adjectives.
   - \`situation\` is what is happening NOW and is true for every persona: what triggered the call and the shared
     facts. One persona's own facts (budget, family, motivation, areas) go in that persona's character (step 8).
   - **Never name or describe one persona** in the brief (situation, steps, items): any persona of the role play plays
     it. Write "you".
   - \`start.who\`: who speaks first. When the AI starts, its first words are each character's opening line. When the
     learner starts (e.g. the agent asks a question after a presentation), write \`start.learnerFirst\`; the stage then
     has the AI say only a short neutral line and wait, so never write an opening line for it anywhere.
   - Name, wrong-name correction, ending on "I'll call you back" and the human-talk rules are added automatically; don't
     repeat them.
   - \`steps\`: 2 to 6, a real conversation, not a checklist; include moments the AI brings in on purpose. Write them so
     any character can play them ("raise one of your concerns", not a specific person's concern).
   - A counterpart (client, colleague, stakeholder) never concedes on the learner's first good move: write at least one
     further pushback or test before the good ending, as a person in that situation would.
   - \`items\`: when the requirements give sample lines, include some short reactions too (kind example), as given.
     Lines only one kind of persona says get a tag (investor, end-user) so the character can point to them.
   - \`ending\`: a limit (time or count), what good looks like, and the exit line if the AI ends it.
   - \`learnerBrief\`: written to the learner: who they are, the situation, the outcome to aim for, the limit. Only the
     situation ("A lead filled in the form after your ad; call them back"), never who they will speak with: no name,
     persona, personality or background of the AI's character, and never the hidden concerns.
   - \`items\`: only lines the trainer gave (objection lists, question banks, sample lines), each with kind, when it
     fits and tags. Never invent lines. With items, write \`itemsGuide\`.
   - In an interview, exam or assessment the AI asks and probes; it never teaches, hints or nudges toward the answer
     unless the requirements ask for coaching during the call.
   - Keep the trainer's own words for facts, lines and rules; don't embellish. Use only this persona's and this
     scenario's details: never borrow another persona's backstory or another scenario's facts from the same document. Never add names,
     people, dates or numbers the requirements don't give: refer to others by role ("a teammate who left"). Fictional names and numbers from the
     requirements stay as they are; never add real people's personal details.
   Fix every reason \`roleplay_draft\` returns in the next call, all at once; at most 3 drafts.
6. **Show the trainer, in your reply,** once a draft passes: the learner brief and a short summary (the AI's role, the
   situation, the steps, how it ends), the personas that will play it with a line on each character, and which values
   you proposed rather than took from them; then ask whether to publish or change something. Never end a turn on a tool call without this reply. Change it by chat as
   they ask.
7. **Publish** with \`roleplay_publish\` (they approve it on a card), then reply with what the studio stored: the role
   play's name, slug and version, or its error.
   A family of scenarios is one role play each: write and publish them one at a time, keeping shared parts identical.
8. **Write each persona's character** right after publishing: a role play can't start until at least one persona has
   one. Add the other personas with \`roleplay_personas_set\`, then one \`roleplay_character_set\` per persona (each
   approved on a card). A character is markdown written to "you", with these sections as the requirements support them:
   - \`## Who you are here\`: your relationship to the learner and your facts on this call (type, budget, situation).
   - \`## What you want and your concerns\`: your aim; each concern as you'd put it, when it comes up, what eases it;
     mark the ones you keep hidden "(hidden until earned)". Never the answers.
   - \`## Your opening line\` when the AI starts: your exact first words, no name unless it is yours. When the learner
     starts, write \`## Your first reply\` instead: how you answer their first question (e.g. a stall), never words to say
     before they speak.
   - \`## How you react\`: observable things the learner does that make you open up or pull back, and how THIS person
     says no (indirect, blunt, joking, going quiet). Reasonable and firm, not hostile.
   - \`## How you talk on this call\`: how much you talk, pace, anything the requirements say.
   - \`## How you end\`: which next step you accept, and when you decline.
   Keep the trainer's own words for facts; never borrow another persona's details, and never put several personas'
   lines in one character or in the brief ("play only your own line" lists): one character, one person. A character is
   for this role play only: when the same persona plays another role play, write that one from that role play's requirements, never by
   copying. A persona without a character is never picked.

To **change** a role play written this way (\`roleplay_read\` shows kind \`roleplay-brief\`, its \`brief\` and each
persona's \`character\`): a change to how one persona behaves is that persona's character (\`roleplay_character_set\`, no
new version); a change to the situation, flow or ending is the brief: edit only what was asked, keep its id, draft,
show what changed, publish. It becomes the next version.
`;

const procedure = `# Build one role play from recordings

Use this only when the trainer asks for a role play built from their recordings (sessions where they run that
practice with a learner). It is not a twin skill: if the request is about the trainer's knowledge, decisions or approach on a topic,
stop and use \`twin-creator\` instead.

Do all the work yourself. Plan the whole run before reading anything.

1. **Understand the requirement.** Restate it in one line: the practice, the trainer part and the learner part. Write it to \`specs/<id>.md\`. Note the minimums under "Requirements".
2. **Find sessions.** Call \`knowledge_list\`, then at most 2 \`knowledge_search\` calls. Pick at least 3 two-person recordings that show this practice, not just its topic.
3. **Read once.** One \`knowledge_read\` with \`knowledge_list\`: the practice span of each chosen session. Read enough turns to collect the item minimums with about 20% to spare. A second read only for a session that turned out too thin.
4. **Prepare everything, then build.** Write the plan, \`patterns\`, all items, \`skill\` and \`body\` against the requirements. Then call \`roleplay_recording_build\` once.
5. **Fix, don't restart.** \`roleplay_recording_build\` returns the rejected items or the check reasons.
   - Drop a rejected item when you still meet the minimums without it. Re-read a turn only to fix exact \`start\`/\`end\` words.
   - Fix every listed reason in the next call, all at once.
   - At most 3 \`roleplay_recording_build\` calls. If the third still fails, write \`report.md\` with the open reasons, publish, and stop.
6. **Finish.** When the check passes, write \`report.md\` and call \`roleplay_recording_publish\`. It is stored as a role play.

If fewer than 3 sessions show the practice, say so and offer to write it from their requirements instead (above). Never invent lines or expose personal details.

\`note_write\` can only create \`specs/<id>.md\` and \`report.md\`. Never use it for \`patterns.md\`, \`SKILL.md\`, \`scenario.json\` or \`items.json\`; \`roleplay_recording_build\` creates all of those.

# Change an existing role play

Check \`roleplay_list\` first; never create a second role play for the same practice.
- **Builder role play** (\`roleplay-builder\`): change its script with \`roleplay_update\`, its Settings with
  \`roleplay_settings_update\` and its Tools with \`roleplay_tools_update\` (the trainer approves each card). Read it with \`roleplay_read\` first and change only what was asked.
- **Role play built from recordings** (\`roleplay-recordings\`): \`roleplay_recording_load\` writes the published version to
  \`baseline/<slug>/\`. Rebuild with the same scenario id, starting from its plan, steps and items: keep what still holds,
  add the new sessions or method docs, and tell the trainer what changed before \`roleplay_recording_publish\` (approved on a card). It
  becomes the next version; the previous one is kept.
`;

export default defineSkill({
  description:
    "Write or change one role play (a practice session the AI leads, e.g. a client call, a mock interview, a difficult conversation): from the trainer's requirements, or from their recordings. Use for a role-play, practice, rehearsal or mock-interview request, never for a twin skill.",
  content: `${fromRequirements}\n${procedure}\n${requirementsText()}`,
});
