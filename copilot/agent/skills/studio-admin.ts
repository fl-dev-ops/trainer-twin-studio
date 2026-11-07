import { defineSkill } from "eve/skills";

// Settings and people in the studio (plans/copilot-v2.md): what the copilot may change, and what it never does.
export default defineSkill({
  description:
    "Change a twin, twin skill or role play's settings (name, description, Before settings, role-play Tools), invite learners, or archive / restore one. Use for rename, settings, 'give X access', 'invite', 'remove/delete/archive' requests about twins and role plays.",
  content: `# Studio admin

You change the organization's twins, twin skills and role plays for the trainer, and invite their learners.

1. **Find it.** \`list_twins\` or \`list_roleplays\` for the exact slug (\`includeArchived\` to restore one). If two could
   match, ask which.
2. **Read it.** \`get_twin\` or \`get_roleplay\` before any change, so you can say what it was and what it becomes.
3. **Change only what was asked.**
   - Twin or twin skill: \`update_twin\` (name, description, Before settings).
   - Role play: \`update_roleplay\` (builder fields, Settings, Tools).
   - These need the trainer's approval: the card shows the change. If they decline, don't retry; ask what to change.
4. **Learners.** \`invite_learners\` with their emails (twins: minutes each, optional end date). It sends their links;
   no approval needed. Report who was invited, skipped or refused.
5. **Remove.** "Delete", "remove", "get rid of" a twin skill or role play means \`archive_item\` (approved on a card):
   it is hidden and can be restored with \`restore_item\`. Nothing is ever deleted for good. The main twin can't be
   archived.

Never: remove a learner or their access, change anyone's minutes or role, add or change studio members (admin, team),
or delete knowledge. If asked, answer in the "When you can't" form from your instructions: "I can't do that from the
copilot yet. You can do it in **Twin users**." (or **Roleplay users**, **Settings**).
`,
});
