import { defineSkill } from "eve/skills";
import { requirementsText } from "../lib/ingest";

// The role-play procedure, plus the limits its tools enforce (built from the same constants as the checks), so the
// agent knows every limit before its first build. Loaded only for a role play; a twin skill is a different product.
const procedure = `# Build one role play

A role play is a practice session the AI leads, built from recordings where the trainer runs that practice with a
learner. It is not a twin skill: if the request is about the trainer's knowledge, decisions or approach on a topic,
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

If fewer than 3 sessions show the practice, report that and stop. Never invent lines or expose personal details.

\`write\` can only create \`specs/<id>.md\` and \`report.md\`. Never use it for \`patterns.md\`, \`SKILL.md\`, \`scenario.json\` or \`items.json\`; \`build_scenario\` creates all of those.
`;

export default defineSkill({
  description:
    "Build one role play (a practice session the AI leads) from a trainer's recordings. Use only for a role-play, practice or rehearsal request, never for a twin skill.",
  markdown: `${procedure}\n${requirementsText()}`,
});
