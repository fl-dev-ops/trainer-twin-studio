---
name: roleplay
description: Role plays (Scenarios) - listing them, reading one, and changing an existing role play's script fields, Settings (screen share, uploads) or workspace Tools (canvas, code editor, PDF viewer, multiple choice, knowledge search). Use this for any "change", "turn on", "edit" or "what's in" request about a role play. To write a new role play or rewrite one's content, use roleplay-creator instead.
---

# Role play

## Tools
| Tool | Does | Card |
|---|---|---|
| `roleplay_list` | Lists role plays: slug, kind (`roleplay-brief`, `roleplay-builder`, `roleplay-recordings`), version, archived. | no |
| `roleplay_read` | Reads one: Settings, Tools, version, invites, and its brief or builder fields. | no |
| `roleplay_update` | Changes a **builder** role play's script fields (client, situation, opening, goals, rubric…). | yes |
| `roleplay_settings_update` | Changes Settings: screen share, upload before the call (and whether required), upload during the call, upload title and instruction. | yes |
| `roleplay_tools_update` | Switches workspace tools on or off. | yes |
| `roleplay_draft`, `roleplay_publish` | Check and publish a role play written from requirements; used inside `roleplay-creator`. | publish: yes |
| `roleplay_recording_*` | Build, check, load and publish a role play from recordings; used inside `roleplay-creator`. | publish: yes |

## How
1. `roleplay_list` for the exact slug. If two could match, ask which.
2. `roleplay_read` it, so the card can show before and after.
3. How the script is changed depends on the kind, because each kind is stored differently:
   - `roleplay-builder`: `roleplay_update`.
   - `roleplay-brief`: `roleplay-creator`; edit its brief (same id), `roleplay_draft`, `roleplay_publish`.
   - `roleplay-recordings`: `roleplay-creator`; rebuild from `roleplay_recording_load`.
4. Settings and Tools work the same for every kind. Script, Settings and Tools are separate calls with separate cards.
5. If the trainer declines, don't retry; ask what to change. Report only what the studio says it saved.

**Example.** "Let learners upload their CV before the mock interview and show it in the PDF viewer" → `roleplay_read` → `roleplay_settings_update` `{ preUpload: true, uploadTitle: "Your CV" }` → `roleplay_tools_update` `{ preview: true }`. That's two cards.

## Rules, and why
- Pass \`label\` with the current name on every update, so the card says what is changing in the trainer's words, not a slug.
- If you filled in anything the trainer didn't say (a title, an instruction, a voice, a description), list those fields in `proposed`: the card marks them "(suggested)", so the trainer approves a suggestion knowingly.
- Pass only what changes; omitted fields keep their value, and a full resend risks overwriting what the trainer didn't mean to touch.
- The PDF viewer shows uploaded documents, so it's useless without an upload in Settings. Say so if it's turned on alone.
- Change the existing role play for a practice rather than add a second one; learners would otherwise see duplicates.
- Archived role plays can be read but not changed.

## Cannot
Change a role play's voice, intro video or turn limit, archive, restore or delete it, invite or remove learners, or see its sessions and reports. For these, say: "I can't do that from the copilot yet. You can do it in **[Studio section]**." Don't guess at what you can't see, and don't say something doesn't exist just because it isn't visible to you; the trainer would act on a wrong answer.
