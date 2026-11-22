import { defineSkill } from "eve/skills";

export default defineSkill({
  description: "Create a main twin or update a twin, role play, or role-play persona. Use for name, description, Before settings, or role-play Tools changes.",
  content: `# Studio edits

1. **Find it.** List twins, role plays, or personas to find the exact match. If two could match, ask which.
2. **Read it.** Read the current settings so you can show what will change. For a new main twin, select the trainer's existing own persona and call \`create_twin\`.
3. **Change only what was asked.** Use \`update_twin\`, \`update_roleplay\`, or \`update_persona\`. For a Copilot-written role play's script, revise the existing brief with the roleplay-creator skill. If a shared persona changes, explain that it affects future sessions of every role play using it.
4. **Wait for approval.** If they decline, don't retry. Report only what was actually saved.

Learner access, billing, archive, delete, and knowledge changes are outside this skill. Direct the trainer to the relevant Studio page.
`,
});
