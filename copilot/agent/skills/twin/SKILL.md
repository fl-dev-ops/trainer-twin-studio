---
name: twin
description: The trainer's twin and its twin skills - listing them, reading one, creating the main twin, renaming, changing a description or the Before settings (screen share, uploads). Use this for any request about "my twin", a twin skill's name or settings, or "create my twin". To build a twin skill or add knowledge to one, use twin-creator instead.
---

# Twin

## Tools
| Tool | Does | Card |
|---|---|---|
| `twin_list` | Lists the main twin and its twin skills (slug, kind, version, archived). | no |
| `twin_read` | Reads one: name, description, Before settings, version, learners. | no |
| `twin_create` | Creates the main twin from the trainer's own persona (`persona_list`, `own: true`). | yes |
| `twin_update` | Changes name and/or description. | yes |
| `twin_settings_update` | Changes Before settings: screen share, upload before or during the call, upload title and instruction. | yes |
| `twin_skill_build`, `twin_skill_load`, `twin_skill_publish` | Build, load and publish a twin skill's content; used inside `twin-creator`. | publish: yes |

## How
1. `twin_list` for the exact slug. If two could match, ask which: changing the wrong twin affects real learners.
2. `twin_read` it, so the card can show before and after.
3. Call the one tool for the part being changed, passing only what changes. A rename plus a settings change is two calls and two cards, so the trainer can approve each separately.
4. If the trainer declines, don't retry; ask what to change. Report only what the studio says it saved.

**Example.** "Turn on screen share for my pricing skill" → `twin_list` → `twin_read` "acme-pricing" → `twin_settings_update` with `{ preScreenshare: true }`.

**Create the main twin** when `twin_list` shows no `main-twin` and `persona_list` has the trainer's own persona: `twin_create` with that slug.

## Rules, and why
- Pass \`label\` with the current name on every update, so the card says what is changing in the trainer's words, not a slug.
- If you filled in anything the trainer didn't say (a title, an instruction, a voice, a description), list those fields in `proposed`: the card marks them "(suggested)", so the trainer approves a suggestion knowingly.
- A twin skill is the trainer's knowledge and approach on one topic; it advises learners. It is not a role play, which is a practice script. Keeping the products separate is what makes each one work.
- Update an existing twin skill rather than create a second on the same topic: two would compete and confuse the twin.
- Archived items can be read but not changed. The main twin can't be archived.

## Cannot
Archive, restore or delete twins or skills, change the twin's voice or avatar, or invite or remove learners. For these, say: "I can't do that from the copilot yet. You can do it in **[Studio section]**." Don't guess at what you can't see, and don't say something doesn't exist just because it isn't visible to you; the trainer would act on a wrong answer.
