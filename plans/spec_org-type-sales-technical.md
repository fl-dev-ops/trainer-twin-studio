# Org Type: Sales and Technical Interview — Spec

**Status:** v6, implemented 2026-10-22 on `feat/org-type` (Twin QnA not started)
**Branch:** cut from `feat/client-roleplay-mode` (its pending work was committed 2026-10-22; the command-polling pause was dropped)
**UI reference:** V4 prototype, https://trainertwin-beta.vercel.app/v4/
(local copy extracted to `/data/workspace/trainertwin-v4-prototype/trainertwin-v4/`)
**Builds on:** `plans/spec_client-roleplay-mode.md` (role-play scenarios, already in progress)

---

## 0. Principle

**One UI for every org. The org type changes only two things:**

1. **How a scenario is configured** (role-play config vs interview config).
2. **What things are called** ("Role play" vs "Scenario"), plus any element explicitly wrapped in `<DisplayForOrg>`.

Everything else (pages, sessions, learners, knowledge, voices, personas, users, settings, Twin QnA)
is the same for both types.

| | `SALES` (Olga's org, to be created) | `TECHNICAL_INTERVIEW` (`careerwithvasanth`, `latencytest`) |
|---|---|---|
| Name in the UI | **Role play / Role plays** | **Scenario / Scenarios** |
| AI plays | A client the learner sells to | The interviewer |
| Scenario config | Situation, hidden truth, learner role, learner goals (≤5), agrees/declines when, client character (behaviour, difficulty, how they talk, guarded-if / opens-up-if), opening line, **rubric** | Interview type (`technical` / `resume`), topics, question counts by type (verbal, MCQ, coding, code-output, system design), follow-ups per question, main questions (resume) |
| Learner scored on | Rubric (points sum to 100) | Evidence coverage per topic and question (as today) |
| Stored at | `agent.data.config.scenario.roleplay` (existing) | `agent.data.config.interview` (existing) |

## 1. Decisions (confirmed 2026-10-22)

1. Exactly two types, `SALES` and `TECHNICAL_INTERVIEW`, one per org.
2. `careerwithvasanth` and `latencytest` are `TECHNICAL_INTERVIEW`. `latencytest`'s 2 role plays and their 6 sessions are deleted (`scripts/remove-mismatched-scenarios.ts latencytest --apply`). Olga's org will be created from a `SALES` invite.
3. Only developers set or change the type (founder invite field, or a script). Owners never see it.
4. No "Communication" category.
5. **Twin QnA is built for both types.**
6. **No cross-kind scenarios.** A Sales org has only role plays; a Technical org has only
   interview scenarios. No org ever lists, runs or edits the other kind. This avoids special cases
   across the editor, list, APIs and reports.
7. Org-specific UI goes through one wrapper, `<DisplayForOrg org="sales">…</DisplayForOrg>`, and one
   wording map, so the sidebar shows "Role plays" for Sales and "Scenarios" for Technical.
8. **No automated tests in this work.** Verification is a manual check in the browser.

## 2. Capability map

| Module id | Responsibility | Depends on |
|---|---|---|
| `org-type` | `OrgType` enum + column, migration, typed accessor, set from invite or developer script | — |
| `org-ui` | `OrgTypeProvider`, `<DisplayForOrg>`, `useOrgCopy()` wording map; sidebar and page titles use it | `org-type` |
| `scenario-config-by-type` | New scenarios use the org's config kind; editor shows the matching config section; APIs validate | `org-type`, `org-ui` |
| `sales-scenario-config` | Rubric, sales persona presets, rubric-based reports | `scenario-config-by-type` |
| `twin-qna` | V4 Twin QnA for both types (own sub-spec) | `org-ui` |

Build order: `org-type` → `org-ui` → `scenario-config-by-type` → `sales-scenario-config` → `twin-qna`.

---

## 3. Data model (`org-type`)

```prisma
enum OrgType {
  SALES
  TECHNICAL_INTERVIEW

  @@map("org_type")
}

model Organization {
  // …existing fields
  type OrgType @default(TECHNICAL_INTERVIEW)
}

model FounderInvite {
  // …existing fields
  orgType OrgType @default(TECHNICAL_INTERVIEW)
}
```

- Migration `20261022120000_organization_type`: create enum, add both columns with default `TECHNICAL_INTERVIEW`.
- Typed column rather than the `metadata` JSON bag (`lib/org.ts` already flags the bag, `ponytail PT-1`).
- Onboarding copies `invite.orgType` onto the new org and never asks.
- `SessionOrg` / `TrainerOrg` / `getOrgBySlug` in `lib/org.ts` gain `type: OrgType`.
- `web/scripts/set-org-type.ts <slug> <SALES|TECHNICAL_INTERVIEW>` switches an existing org. No API, no UI.
- `web/scripts/founder-invite.ts <email> [SALES|TECHNICAL_INTERVIEW]` sets the type on a new invite.
- `web/scripts/remove-mismatched-scenarios.ts <slug> [--apply]` lists (dry run) or deletes scenarios that do not match the org's type, with their sessions.

## 4. Org-aware UI (`org-ui`)

### 4.1 Provider

`app/dash/layout.tsx` already loads the org with `getSessionOrg()` and wraps the shell in
`OrgAccentProvider`. It also wraps it in a new `OrgTypeProvider`, so every client component can read the type.

```tsx
// web/components/org-type-provider.tsx
"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { OrgType } from "@/lib/org-type";

const OrgTypeContext = createContext<OrgType | null>(null);

export function OrgTypeProvider({ type, children }: { type: OrgType | null; children: ReactNode }) {
  return <OrgTypeContext.Provider value={type}>{children}</OrgTypeContext.Provider>;
}

export function useOrgType(): OrgType | null {
  return useContext(OrgTypeContext);
}
```

### 4.2 `<DisplayForOrg>`

```tsx
// web/components/display-for-org.tsx
"use client";

import type { ReactNode } from "react";
import { useOrgType } from "@/components/org-type-provider";
import { ORG_KEY, type OrgKey } from "@/lib/org-type";

/** Renders children only for the given org type(s). */
export function DisplayForOrg({ org, children }: { org: OrgKey | OrgKey[]; children: ReactNode }) {
  const type = useOrgType();
  if (!type) return null;
  const allowed = Array.isArray(org) ? org : [org];
  return allowed.includes(ORG_KEY[type]) ? <>{children}</> : null;
}
```

Usage:

```tsx
<DisplayForOrg org="sales"><RubricStep /></DisplayForOrg>
<DisplayForOrg org="technical"><QuestionCounts /></DisplayForOrg>
```

`org` takes short keys (`"sales"` / `"technical"`) that map to the enum, so JSX stays readable.

It is a wrapper component, not a literal higher-order function (`withOrg(Component)`). It works
inside client components and also around server-rendered children. **It hides UI; it is not
security.** Children are still rendered on the server, so anything sensitive or expensive is gated
on the server with `(await getSessionOrg()).type`, and APIs validate on their own (§5).

### 4.3 Wording map

```ts
// web/lib/org-type.ts
export type OrgType = "SALES" | "TECHNICAL_INTERVIEW"; // re-exported from the Prisma client
export type OrgKey = "sales" | "technical";

export const ORG_KEY: Record<OrgType, OrgKey> = {
  SALES: "sales",
  TECHNICAL_INTERVIEW: "technical",
};

export const ORG_COPY = {
  sales:     { scenario: "Role play", scenarios: "Role plays", newScenario: "New role play", trainer: "Sales trainer" },
  technical: { scenario: "Scenario",  scenarios: "Scenarios",  newScenario: "New scenario",  trainer: "Interview trainer" },
} as const satisfies Record<OrgKey, Record<string, string>>;
```

`useOrgCopy()` (client) and `orgCopy(type)` (server) return the right entry. The sidebar `NAV`
item `{ title: "Scenarios", href: "/agents" }` becomes `{ copyKey: "scenarios", href: "/agents" }`.
About 27 hard-coded "Role play"/"Scenarios" strings in `app/` and `components/` move to the map.

## 5. Scenario config by type (`scenario-config-by-type`)

```ts
// web/lib/org-type.ts
// "twin" is the code's existing name for an interview scenario.
export type ScenarioKind = "roleplay" | "twin";
export const SCENARIO_KIND: Record<OrgType, ScenarioKind> = {
  SALES: "roleplay",
  TECHNICAL_INTERVIEW: "twin",
};
```

Rules:

1. **Create:** "New role play" / "New scenario" opens the org's builder (`roleplay-editor.tsx` for
   Sales, `agent-editor.tsx` for Technical). The trainer is never asked to choose.
2. **Edit:** the editor shows the org's config section. Shared fields use the same layout for both.
3. **List / run:** no extra filters. Saves are guarded and mismatched data is removed by the
   clean-up script, so lists can only contain the org's kind.
4. **APIs:** `assertScenarioFitsOrg()` in `lib/org.ts` runs inside `saveSpecDraft`, `publishSpecDraft`
   and the YAML `saveSpec`, so every write path (builder, Copilot, YAML editor) is covered; routes
   answer 422. The generate route also rejects the other kind before doing any work.
5. **Data clean-up:** before the gate goes live, scenarios of the wrong kind are removed from each
   org (see §13). After that, the gate guarantees it cannot happen again.
6. **Copilot:** not changed. If it drafts the wrong kind, the save is rejected with a clear 422 message.
   Passing the org type into the Copilot is a follow-up.
7. **Unchanged:** sessions, learner links (`(org)/s/[code]`), voice agent (`agent/src/agent.py`),
   which all run the scenario's pinned compiled spec.

## 6. Sales config gaps (`sales-scenario-config`)

| V4 feature | Prototype source | Work |
|---|---|---|
| **Rubric**: scores with points summing to 100, picked from the role-play type (sales, cold call, wait-and-see, options collector, fee push-back), editable | `ROLE_RUBRICS`, `syncRubric` | `rubric` in `roleplayInputSchema`; builder step; session report scores against it |

**How scoring works today (no rubric yet):** after each session, `lib/generate-session-report.ts`
asks an LLM for a summary, 2–4 tags, up to 3 key moments, one "focus next time" tip and an
optional **single holistic score 0–100** ("based on role mastery"). For role plays it is grounded
on the learner goals, compiled as evidence keys graded met / partly / not met. There is no
per-criterion breakdown and no weighting. In the local DB, 123 of 125 reports have that one number.

**What the rubric adds (Sales only):** a named list of criteria with points summing to 100, e.g. a
cold call: opening and permission to talk 20, clear reason for calling 20, handling the brush-off
25, value in one line 15, follow-up agreed 20. The builder suggests one from the role-play type and
the trainer can edit it. The report then returns points per criterion with a one-line reason, and
the overall score is their sum, so it is explainable and comparable between learners.
Interview reports stay as they are.
| **Sales persona presets**: Daniel, Rajesh, Claire, Elena, Marcus | `RPS_PRESETS`, `PERSONAS` | Seed as personas; "start from template" |

## 7. Twin QnA (`twin-qna`, both types)

The V4 "Twin QnA" screen: the trainer creates a course-specific twin from a link and files, it
answers learners' questions in the trainer's voice, and the trainer calibrates replies (thumbs,
reasons, flagged issues). Prototype source: `pageDoubt`, `pageBotCreate`, `pageBotDetail`,
`CALIBRATIONS`. Same screen for both types; only example copy differs via `ORG_COPY`.
It is the largest piece and gets its own spec (`plans/spec_twin-qna.md`) after this one ships.

---

## 8. Impact areas

| Area | Files | Change | Risk |
|---|---|---|---|
| Schema | `web/prisma/schema.prisma`, new migration | `OrgType`, `Organization.type`, `FounderInvite.orgType` | Low; additive with defaults |
| Org accessors | `web/lib/org.ts` | Add `type` | Low |
| Org type module (new) | `web/lib/org-type.ts` | `ORG_KEY`, `ORG_COPY`, `SCENARIO_KIND` | — |
| Provider + wrapper (new) | `web/components/org-type-provider.tsx`, `web/components/display-for-org.tsx` | Context, `<DisplayForOrg>`, `useOrgCopy()` | Low |
| Dashboard layout | `web/app/dash/layout.tsx` | Wrap in `OrgTypeProvider` | Low |
| Sidebar | `web/components/app-sidebar.tsx` | "Role plays" / "Scenarios" from the map | Low |
| Wording | ~27 strings across `app/` and `components/` (scenario list, editors, page headers) | Use `useOrgCopy()` | Low; easy to miss one, covered by browser check |
| Onboarding | `web/app/api/onboarding/route.ts` | Copy `invite.orgType` | Low |
| Dev script (new) | `web/scripts/set-org-type.ts`, `web/package.json` | Switch type | Low |
| Scenario list / create | `web/app/dash/agents/page.tsx`, `web/components/scenario-list.tsx`, `web/lib/scenario-cards.ts` | Create opens the org's builder | Low |
| Scenario editors | `web/app/dash/agents/[slug]/edit`, `web/components/agent-editor.tsx`, `web/components/roleplay-editor.tsx` | Config section by scenario kind; rubric step | Medium |
| Scenario APIs | `api/agents/[slug]/generate`, `api/spec*`, `api/spec-drafts`, `api/v1/scenarios` | 422 rules in §5 | Medium; public API, document in `docs/openapi.yaml` |
| Role-play schema | `web/lib/roleplay.ts` | `rubric` | Low |
| Reports | `web/lib/generate-session-report.ts`, `web/lib/session-report.ts` | Rubric scoring for role plays | Medium |
| Copilot | `copilot/`, `web/lib/spec-generation.ts` | Pass org type | Low |
| Seed | `web/prisma/seed.ts`, `web/data/roleplay` | Sales persona presets | Low |
| Twin QnA | new pages, APIs, tables (sub-spec) | New feature | High; scoped separately |
| Unchanged | sessions, learner links, `agent/src/agent.py` | — | Verify only |

## 9. Commands

```bash
cd web
bun install
bunx prisma migrate dev --name organization_type   # local Postgres tt-pg :5433 only
bun run lint
bun run build
bun run dev                                         # :3000
```

Next.js is repo-pinned with breaking changes; read `web/node_modules/next/dist/docs/` before writing code (`web/AGENTS.md`).

## 10. Verification

No automated tests for this work (decision 8). Each phase ends with a manual check in the browser
on the local database, logged in to `latencytest` (Sales) and `careerwithvasanth` (Technical).

## 11. Boundaries

- **Always:** validate on the server; use `<DisplayForOrg>` / `useOrgCopy()` instead of inline `type === …` checks in JSX; keep interview code paths unchanged; test on the local dump.
- **Ask first:** changes to `agent/src/agent.py`; running the script or migration on prod; new dependencies; committing prototype media.
- **Never:** rely on `<DisplayForOrg>` for access control; show the type to owners; delete scenarios on a type switch; seed real-person data from the prototype.

## 12. Success criteria

1. After migration, `careerwithvasanth` is `TECHNICAL_INTERVIEW` and `latencytest` is `SALES`.
2. Both orgs see the same pages; Sales says "Role play(s)", Technical says "Scenario(s)", everywhere.
3. `<DisplayForOrg org="sales">` content appears only in Sales orgs, and `org="technical"` only in Technical orgs.
4. A Sales org lists, runs and creates only role plays; a Technical org only interview scenarios.
5. The API enforces the rules in §5.
6. Role-play session reports score against the rubric; interview reports are unchanged.
7. Existing interview scenarios in `careerwithvasanth` work exactly as before.

## 13. Data clean-up (decided)

Delete `latencytest`'s 2 role plays and their sessions; `latencytest` stays technical interview.
Run `bun scripts/remove-mismatched-scenarios.ts <slug>` (dry run) then `--apply`, on each database.

---|---|---|---|
| `careerwithvasanth` | Technical | 0 | 10 (49 sessions) |
| `latencytest` | Sales | 2 (6 sessions) | **5 (123 sessions)** |

`latencytest` becomes Sales but holds 5 interview scenarios with 123 sessions. Options:
(a) archive them (hidden, sessions kept for history), (b) delete them and their sessions, or
(c) keep `latencytest` Technical and create a new demo org for Sales.

---

## 14. Implementation guide (draft — becomes `tasks/plan.md` once approved)

**Phase A — `org-type` (≈1 day)**
1. Enum + columns + migration (incl. `latencytest` → `SALES`); clean-up per §13. *Verify:* query local DB.
2. `lib/org.ts` gains `type`; onboarding copies invite type. *Verify:* build + API test.
3. `scripts/set-org-type.ts`. *Verify:* flip `latencytest` and back.

**Phase B — `org-ui` (≈1 day)**
4. `lib/org-type.ts`, `OrgTypeProvider`, `<DisplayForOrg>`, `useOrgCopy()`.
5. Dashboard layout wraps provider; sidebar wording. *Verify:* both orgs in the browser.
6. Replace the ~27 hard-coded strings. *Verify:* `grep` finds none left; browser check.

**Phase C — `scenario-config-by-type` (≈2 days)**
7. Create/edit use the org's builder; lists and talk page filter to the org's kind.
8. API 422 rules + OpenAPI.
9. Copilot/generation receive org type.
*Checkpoint:* one session per org end to end in the browser.

**Phase D — `sales-scenario-config` (≈3–4 days)**
10. Rubric in schema + builder step.
11. Rubric scoring in session report.
12. Seed Sales persona presets; "start from template".

**Phase E — `twin-qna`** — write `plans/spec_twin-qna.md`, then build.
