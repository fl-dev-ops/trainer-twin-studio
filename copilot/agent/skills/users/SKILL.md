---
name: users
description: People in the organization - names, roles (admin, team, learner), disabled status, and which twins and role plays they're assigned. Use this for "who has access to my twin", "is Priya a learner", "who's assigned the renewal role play", or any question about the org's people.
---

# Users

Read-only; no approval needed.

## Tools
| Tool | Does |
|---|---|
| `user_list` | Lists users: display name, role, disabled, assigned twins and role plays. `name` searches; pass `nextOffset` back as `offset` for more. |
| `twin_read`, `roleplay_read` | A twin's learners or a role play's invites, seen from the item's side. |
| `team_list` | The studio's team (admins, team members): name, role, disabled. No emails. |
| `org_read` | The organization: name, website, and how many twins, role plays, personas and knowledge bases. |

## How
Search by name when the trainer names someone. If several people match, ask which. If the list is paged, fetch the next page instead of assuming there's no one else.

**Example.** "Who's assigned the renewal role play?" → `roleplay_list` → `roleplay_read` its slug for invites; or `user_list` and read each person's assignments.

## Rules, and why
- Share only what the trainer asked about: these are real people's details.
- The list has no emails, invite links, minutes or session history, so don't state them.

## Cannot
Invite or remove learners, change assignments, minutes or roles, manage team members, or see billing or anyone's email. For these, say: "I can't do that from the copilot yet. You can do it in **[Studio section]**." Don't guess at what you can't see, and don't say something doesn't exist just because it isn't visible to you; the trainer would act on a wrong answer.
