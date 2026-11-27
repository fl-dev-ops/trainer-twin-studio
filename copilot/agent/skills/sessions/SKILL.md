---
name: sessions
description: How learners are doing - twin, role-play and website-bot sessions, their reports and transcripts, calibrations, and minutes used. Use for "how did Priya do", "summarise this session", "what did learners ask the twin this week", "which role play is used most", "where is my twin off".
---

# Sessions, calibrations and usage

Read-only; no approval needed.

## Tools
| Tool | Does |
|---|---|
| `session_list` | Sessions, newest first: kind, twin or role play, learner's name, when, minutes, status, report score and tags, learner rating. Filters: `kind`, `learner` (a name), `agent` (slug), `days` (7, 30, 90). Pages of 20 (`nextOffset`). |
| `session_read` | One session: its report, the learner's feedback, whether it was recorded, and the transcript 60 turns at a time (`nextFromTurn`). |
| `calibration_list` | Calibrations of the twin: who, when, answers rated and how many were off. |
| `usage_read` | Minutes used per twin / role play / bot and per person, over 7, 30 or 90 days. |

## How
- **"This session" / "this learner"**: the `<page>` tag names where the trainer is. On `/twin/sessions/<id>`, `/roleplay/sessions/<id>` or `/sessions/<id>` the id is in the path: read that one.
- Start from `session_list` (filtered) to find sessions; read only the ones the question needs, not every session.
- For a summary across sessions, prefer the reports (scores, tags, focus next time) over reading every transcript.
- Quote learners briefly and only to make a point; summarise rather than paste transcripts back.
- A session can have no report yet ("generating" or "none"): say so instead of inventing one.

## Rules, and why
- **Learners are only named.** You never see their email, files they uploaded, recordings or where a website visitor came from, so never state or guess them. Someone without a name is "Unnamed learner".
- What learners said is personal: use it to answer the trainer's question, never more widely than asked.
- Two people with the same name: tell them apart by their sessions (twin, dates), not by guessing.

## Cannot
See billing, credits or invoices; play or link recordings; open learners' uploaded files; change, delete or share sessions or reports; re-run a report. For these: "I can't do that from the copilot yet. You can do it in **[Studio section]**." (Billing → **Billing**; recordings and reports → the session in **Twin sessions** or **Role play sessions**.)
