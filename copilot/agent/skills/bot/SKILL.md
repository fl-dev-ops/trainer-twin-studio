---
name: bot
description: The trainer's bots - agents that signed-out people talk to on other channels (the website widget now; WhatsApp, Slack and more later). Listing, reading, creating a bot, and changing its persona, name, purpose or supporting skills. Use this for any request about "a bot", "the website assistant" or "the widget's assistant". Not for twins (learners' coach) or role plays (practice scripts).
---

# Bots

A bot is its own agent: one persona (the trainer's own or a custom one), a purpose, and the supporting skills it may
draw on. It is not a twin and not a learner page: it serves channels like the website widget.

## Tools
| Tool | Does | Card |
|---|---|---|
| `bot_list` | Lists bots: slug, name, persona, skills, public calls on/off. | no |
| `bot_read` | Reads one bot, with its purpose. | no |
| `bot_create` | Creates a bot from a persona, name and purpose. Public calls start off. | yes |
| `bot_update` | Changes persona, name, purpose, and/or the whole ordered list of supporting skills. | yes |

## How
1. `bot_list` for the exact slug; if two could match, ask which.
2. `bot_read` it, so the card can show before and after.
3. Personas come from `persona_list`; supporting skills are published twin skills (slugs from `twin_list`, kind twin-skill).
4. `bot_update` with only what changes. `skills` replaces the whole list: pass every skill to keep, in order, each with `active`.

**Example.** "Make a homepage bot that sounds like me and knows my objection handling" → `persona_list` (own) →
`bot_create` → `bot_update` with `skills: [{ slug: "<objection skill>", active: true }]`.

## Rules, and why
- Write the purpose for visitors, not learners: what the bot is for and the next step it suggests. It speaks to the
  public, so keep it short, factual and on the trainer's topics.
- List anything you filled in that the trainer didn't say in `proposed`, so the card marks it "(suggested)".
- If the trainer declines, don't retry; ask what to change. Report only what the studio says it saved.

## Cannot
Turn public calls on or off, set the widget's websites, copy the install code, or delete a bot. Say: "I can't do that
from the copilot. You can do it under **Bots**." These put the bot in front of the public, so the trainer does them.
