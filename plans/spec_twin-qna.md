# Twin QnA — Spec

**Status:** draft v1, 2026-10-22 (Phase 1; no code yet)
**Branch:** `feat/twin-qna`, cut from `feat/org-type`
**UI reference:** V4 prototype "Twin QnA" (`pageDoubt`, `pageBotCreate`, `pageBotDetail`, `CALIBRATIONS` in `app.js`)
**Builds on:** `plans/spec_org-type-sales-technical.md` (org types), `plans/spec_client-roleplay-mode.md` (third brain mode follows the same pattern)

---

## 1. Objective

A **Twin QnA** is the trainer's twin set up for one use case (e.g. "Handling client objections",
"The off-plan sales process", "React interview prep"). Learners open it and **ask their own
questions**; the twin answers the way the trainer would, grounded in the trainer's knowledge and
course materials, by voice or chat. The trainer tests it first, marks replies that are off, and the
twin learns from those notes.

It is the reverse of the other two kinds:

| Kind | Who leads | AI plays | Org type |
|---|---|---|---|
| Role play | Learner | A client | Sales |
| Interview scenario | AI | The interviewer | Technical interview |
| **Twin QnA** | **Learner asks** | **The trainer's twin** | **Both** |

Same UI for both org types (decision 2026-10-22); only example copy differs.

**User stories**
- As a trainer, I create a Twin QnA from my knowledge plus course materials for one use case, give it a name and description, and get a link to share.
- As a trainer, I test it in a call, mark replies "like" or "off" with a reason, and the twin uses my notes from then on.
- As a learner, I open the link, ask questions by voice or chat, can share my screen or upload an image if allowed, and can report a bad answer.
- As a trainer, I see each Twin QnA's conversations, the questions learners ask, flagged answers and my calibrations.

## 2. What the prototype shows (field inventory)

**Twin QnA page** (sidebar "Twin QnA"): grid of use-case twins. Card: cover with the twin's
looping video and a sample learner question, title, description, learner avatars, a red flag when
a learner reported an issue. Menu: Edit, Calibrate, Try as learner, Share, Remove.

**Create** ("Create a twin persona for specific usecase"):
1. *All your knowledge* toggle (website, socials, whole knowledge base), with a "show sources" dialog.
2. *Course materials*: drop files (PDF, DOCX, slides) and recordings/links.
3. *Additional settings*: Enable screen share; Enable upload (image or file).
4. Save and create → processing progress ("Reading your knowledge… / course materials… / Drafting your bot…").
5. Preview: the twin, an editable **name** and **description** (drafted from the materials).
6. **Calibrate** call: the trainer talks to the twin; each twin reply can be marked like / off; "off" asks for a reason (tags + free text); the twin acknowledges and offers another try.
7. **Share link** appears after the first calibration, then Done.

**Detail**: conversations by learners (Q&A threads), stats, calibration history, flagged replies.

## 3. Design

### 3.1 Data: a Twin QnA is a scenario (Agent) of a third kind

Stored like role plays, at `agent.data.config.scenario.qna`:

```ts
type StoredQna = {
  version: 1;
  description: string;          // shown to learners and on the card
  sample_question?: string;     // card quote, e.g. "My client went quiet after the viewing"
  knowledge: { all: boolean; knowledge_bases: string[] }; // all = every indexed org KB
  allow_screen_share: boolean;
  allow_upload: boolean;
  calibrations: Array<{          // trainer notes the twin follows from then on
    question: string;
    reply: string;
    verdict: "like" | "off";
    reasons: string[];          // e.g. "Too long", "Not how I'd say it", "Wrong facts"
    note?: string;
    created_at: string;
  }>;
};
```

- Persona: the org's trainer persona (the twin), so voice and style come from what already exists.
- Course materials upload into a per-QnA knowledge base (`qna-<slug>`) through the existing
  knowledge pipeline (S3 → index → Chroma), so retrieval and citations work as today.
- Reuses: draft/publish/versioning, Deployment + share code links, `InterviewSession` for every
  conversation (transcript, recording, report), `IssueReport` for learner flags. `IssueReport` has
  no session link today, so it gets two nullable columns, `sessionId` and `agentId` (additive migration).
- Org-type guard: `scenarioFitsOrg` allows `qna` for **both** types (role play only in Sales,
  interview only in Technical, QnA everywhere).

### 3.2 Runtime: a third brain mode

Same pattern as role-play mode in `chat/` (`session-spec.ts`):

- `TWIN QNA MODE` system block: answer the learner's question as the trainer would; ground every
  factual claim with `search_knowledge` scoped to the QnA's knowledge bases; use `search_style` for
  phrasing; ask one clarifying question when the question is vague; never interview or score the learner.
- The trainer's calibration notes are injected as "how I want you to answer" guidance
  (latest first, capped, "off" replies with their reasons and notes).
- Interview tools off (`session_plan`, résumé tools); workspace tools only when screen share / upload
  is enabled; the learner can end any time.
- Opening: a short greeting naming the use case ("Ask me anything about objections").
- Reports: a light summary (questions asked, topics, anything the twin could not answer) — no score.

### 3.3 Learner access

Share link → existing `/s/<code>` flow with a QnA deployment. See open question 1 on sign-in.

### 3.4 UI (Studio)

- Sidebar: **Twin QnA** under Create, for both org types.
- `/qna` list (cards as in V4), `/qna/new` create flow, `/qna/[slug]` detail, `/qna/[slug]/calibrate` call.
- The calibration call reuses `SessionView` with a rating control on each twin reply; ratings call
  `POST /api/qna/[slug]/calibrations`, which appends to `calibrations` and saves a new draft revision.
- Learner side: `SessionView` gains a "Report answer" action on twin replies → `IssueReport`.

## 4. Impact areas

| Area | Files | Change | Risk |
|---|---|---|---|
| Kind + guard | `web/lib/org-type.ts`, `web/lib/org.ts` | `ScenarioKind` gains `qna`; allowed for both types | Low |
| QnA schema/builder (new) | `web/lib/qna.ts`, `web/lib/qna-drafts.ts` | Input schema, `buildQnaBundle`, stored shape | Low |
| Knowledge | `web/lib/specs.ts`, `web/lib/org-knowledge.ts` | Per-QnA knowledge base for course materials | Medium |
| APIs (new) | `web/app/api/qna/**` | Create/save/publish, calibrations, list/detail | Medium |
| Pages (new) | `web/app/dash/qna/**`, `web/components/qna-*` | List, create, detail, calibrate | Medium |
| Sidebar | `web/components/app-sidebar.tsx` | "Twin QnA" item | Low |
| Lists | `web/lib/scenario-cards.ts`, `web/lib/specs.ts` | Keep QnA out of the Role plays / Scenarios list | Low |
| Brain | `chat/agent/**` (`session-spec.ts`, instructions, tool gates) | `TWIN QNA MODE` | **High**; must not change interview or role-play prompts |
| Voice agent | `agent/src/agent.py` | Expected none (uses the brain); verify opening/end | Verify |
| Session view | `web/components/session-view.tsx` | Reply rating (calibration), report answer (learner) | Medium |
| Reports | `web/lib/generate-session-report.ts` | QnA summary, no score | Low |
| Schema | `web/prisma/schema.prisma` | `IssueReport.sessionId`, `IssueReport.agentId` (nullable) | Low; additive |
| Copilot | `copilot/agent/instructions/organization.ts` | Mention Twin QnA exists; no Copilot building of QnAs in v1 | Low |

## 5. Commands

```bash
cd web && bun run dev                      # studio :3000
cd chat && bun run dev                     # brain
cd web && npx tsc --noEmit -p . && npx eslint <changed files>
```

## 6. Boundaries

- **Always:** interview and role-play prompts byte-identical; server-side kind checks; reuse the knowledge pipeline.
- **Ask first:** schema migrations beyond JSON config; changes to `agent/src/agent.py`; new dependencies.
- **Never:** let calibration notes override safety or invent facts; let a QnA twin score or interview the learner.

## 7. Success criteria

1. A trainer in either org type creates a Twin QnA from all knowledge and/or uploaded materials, names it, and publishes it.
2. In a calibration call, marking a reply "off" with a reason changes how the twin answers the same question on the next try.
3. A learner opens the share link, asks by chat and by voice, and gets grounded answers in the trainer's style; screen share / upload follow the toggles.
4. A learner can report an answer; the card shows a flag and the detail page lists it.
5. Interview scenarios and role plays behave exactly as before.

## 8. Open questions

1. **Learner access:** must learners sign in (as today for practice links), or can anyone with the link ask questions?
2. **Channels for v1:** voice and chat both, or chat first and voice next?
3. **"My Twin" card:** the prototype also has one general twin over all knowledge. Is that just a Twin QnA with "All your knowledge" on, or a separate thing?
4. **Recordings:** course materials as files only in v1, or also YouTube/recording links (the YouTube connector exists)?
5. **Copilot:** should the Copilot also create Twin QnAs in v1, or only the Studio form?

## 9. Implementation guide (draft)

**Phase A — model (≈1 day):** `qna` kind + guard; `lib/qna.ts` schema/builder; per-QnA knowledge base.
**Phase B — Studio (≈3 days):** sidebar, list, create (knowledge toggle, materials upload, settings, name/description draft), detail, publish + share link.
**Phase C — brain (≈3 days):** `TWIN QNA MODE` in `chat/`, tool gates, opening, calibration injection; prompt-contract check that interview/role-play output is unchanged.
**Phase D — calibration & feedback (≈2 days):** rating in calibration call, calibrations API, learner "report answer", flags on cards/detail.
**Phase E — reports (≈0.5 day):** QnA session summary.
