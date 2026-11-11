# TrainerTwin module specs

How each part of TrainerTwin is supposed to work, written from the code as it is today: what it does, its rules
(what's allowed and what isn't), its lifecycle, and where the code lives. These are the reference for writing tests
and for deciding what's a bug. One file per module; `credits.md` and `payments.md` are the most settled.

Not the public API docs (those are in `docs/`, published). Not plans (those are in `plans/`, intent and history).

## Two kinds of spec

- **Rule specs** (`people.md`, `billing.md`) say how something *must* work. They are written and agreed **before** the code; the
  code follows them, and a difference is a bug in the code. Each lists checks that must always hold.
- **Module specs** (everything else) describe the code as it is, using the rules below. A module spec that
  disagrees with a rule spec is a bug to fix in the code, listed under *Mismatches* until it is fixed.

Each rule spec ends with a **Refusals** table: one row per condition the platform refuses, with its code, status,
message, when it applies and every layer that must check it. The same condition always gives the same code, status
and message. Anything a rule spec doesn't describe is refused. Every code appears in a test titled `refuses <code>`;
a module spec whose code refuses differently is a bug in the code (list it under *Mismatches*).

(Added 11 Nov 2026: module specs only ever described the code, so an email-based assignment model nobody wanted was
documented as "how it works" and never questioned. See `plans/people-and-sign-in.md`.)

## Rules for writing a module spec

1. **Describe what the code does, not what it should do.** (Check it against the rule specs.) Read the code. Every rule and flow points at where it
   lives (`web/lib/minutes.ts` `grantMinutes`, `web/app/api/v1/users/route.ts` POST). No pointer, no claim.
2. **Intent vs code.** Read `PRODUCT.md` and the relevant `plans/*.md`. Where they disagree with the code, say so in
   *Mismatches*; don't silently pick one.
3. **Simple words.** Short sentences, plain English, tables where they help. A new engineer or a tester should get
   it in one read. Explain each term the first time.
4. **Rules are testable.** Write each rule so a test could check it: "A learner can be given at most 360 credits in
   total (usage does not free room); a grant past that is refused with 400." Not "credits are limited".
5. **Stay in your module.** For something another module owns, link its spec (`see [Sessions](sessions.md)`) instead
   of re-describing it. Describe the boundary: what your module hands over and what it expects back.
6. **Don't guess.** If the code is unclear or two places disagree, put it in *Open questions* with both pointers.
7. **Read only.** Don't change any code, tests or other docs. Write only your own spec file. Don't commit.

## Template (every spec uses these sections, in this order; write "None" rather than dropping one)

```markdown
# <Module name>

> One-paragraph summary: what this module is for, in plain words.

## Who uses it
Roles (TrainerTwin staff, org admin, team, learner, API integrator, the voice agent…) and what each can do here.

## Words used here
Term → meaning, for every term this spec relies on (and the code's name for it, when different).

## Data
The tables / records this module owns: key fields, what each means, allowed values, and who writes them.
Lifecycles as small state lists (e.g. assignment: pending → used; pending/used → cancelled).

## How it works
The main flows, step by step, each with code pointers. Include the happy path and what happens on failure.

## Rules
Numbered, testable rules: permissions (who may do what), limits, validation, ordering, idempotency, uniqueness,
what is NOT allowed. Each with a pointer. These are what tests will check.

## Entry points
Pages, API routes (method + path), tRPC procedures, scripts, crons, webhooks, emails sent — with file paths.

## Talks to
Other modules and outside services (Razorpay, LiveKit, Resend, S3, Chroma, LLMs…): what goes in and out.

## Edge cases and limits
Unusual situations and how the code handles them; `shortcut:` comments; known limits.

## Mismatches
Where `PRODUCT.md`, `plans/`, `docs/`, UI copy or comments say something different from the code.

## Open questions
Unclear behaviour, with the pointers that disagree. Questions for the product owner.

## Tests today
Which test files cover this module, by layer (unit `web/tests/lib`, DB `*.db.test.ts`, flows `web/tests/flows`,
browser `web/e2e`, Python `agent/tests`, `chat/tests`), and the most important untested rules.
```

## Modules

| # | Spec | Scope | Start reading |
| --- | --- | --- | --- |
| 1 | [auth.md](auth.md) | Signing in and up (email/password, Google), sessions and cookies across subdomains, which host serves what (dash./auth./`<org>`.), onboarding, no-org | `web/proxy.ts`, `web/lib/auth.ts`, `auth-client.ts`, `auth-home.ts`, `session-user.ts`, `base-domain.ts`, `web/app/auth/*` |
| 2 | [orgs-and-roles.md](orgs-and-roles.md) | Organizations, roles (admin / team / user), members, disabling, switching orgs, what each role may see and do in the studio | `web/lib/org.ts`, `members.ts`, `auth-roles.ts`, `org-pin.ts`, `org-switch-path.ts`, `web/lib/pages/router.ts`, settings team UI |
| 3 | [invites-and-emails.md](invites-and-emails.md) | Inviting team and learners (Settings, API, assign dialogs), accepting invites, links, and every email the platform sends | `web/lib/invite/*`, `web/lib/email.ts`, `web/app/auth/invite`, `web/components/users/invite-user.tsx` |
| 4 | [credits.md](credits.md) | Meteroid org credits, learner minutes, staff/learner call spending, usage sync, limits | `web/lib/org-credits.ts`, `meteroid.ts`, `minutes.ts`, `minutes-trpc.ts`, `web/workflows/org-credits.ts`, `web/scripts/meteroid-link-org.ts` |
| 5 | [payments.md](payments.md) | Retained phase 1 Razorpay purchases (same phase 3 switch/webhook): payment links, GST invoices, refunds, reconciliation | `web/lib/credit-purchases.ts`, `razorpay.ts`, `web/app/api/razorpay/webhook`, `web/scripts/org-payment-link.ts`, `link-invoice.ts`, `reconcile-purchases.ts` |
| 6 | [twins.md](twins.md) | Twins: the trainer's AI, skills, access (assignments, share links, access-until), calibration, the twin's brain | `web/lib/twins.ts`, `twin-access.ts`, `web/lib/twin/*`, `skill-sources.ts`, `web/app/dash/twin/*`, `web/app/api/twin*` |
| 7 | [roleplays.md](roleplays.md) | Role plays (scenarios): building, publishing, versions, assigning, practice links, repeat practice, reports | `web/lib/roleplay/*`, `assignments.ts`, `deployments.ts`, `specs.ts`, `spec-drafts.ts`, `scenario-ingest.ts`, `web/app/dash/roleplay/*` |
| 8 | [sessions.md](sessions.md) | A practice session's life in the web app: starting (activation), LiveKit room, resume, ending (webhook/finalize), recordings, transcripts, reports, feedback | `web/lib/interview-sessions.ts`, `session-activation.ts`, `session-lifecycle.ts`, `livekit.ts`, `session-*.ts`, `web/app/api/sessions/*`, `web/lib/runtime/*` |
| 9 | [knowledge.md](knowledge.md) | Knowledge bases: documents, uploads, connectors (Notion, YouTube, Google Drive), ingestion, search, Chroma | `web/lib/knowledge.ts`, `web/lib/knowledge/*`, `org-knowledge.ts`, `main-collection.ts`, `chroma-tenant.ts`, `connectors.ts`, `notion*.ts`, `youtube*.ts`, `google-drive*.ts`, `ingestion-*.ts`, `documents.ts`, `web/app/api/knowledge/*`, `ingestion/` |
| 10 | [personas-and-voice.md](personas-and-voice.md) | Personas (who the AI plays), their sources and analysis, avatars and media, voices, TTS, voice cloning | `web/lib/persona*.ts`, `personas.ts`, `headshot.ts`, `voice-passage.ts`, `web/app/api/personas/*`, `web/app/api/tts/*`, `web/app/dash/personas`, `voice` |
| 11 | [public-api.md](public-api.md) | The REST API for integrators: API keys, scopes, rate limit, endpoints, errors, and whether `docs/` matches the code | `web/lib/external-api*.ts`, `web/app/api/v1/*`, `web/app/api/developer/*`, `docs/` |
| 12 | [copilot.md](copilot.md) | The studio copilot: what it can do for a trainer, its tools, how it calls the studio, uploads | `copilot/`, `web/lib/copilot-*.ts`, `web/app/api/copilot/*`, `web/app/api/eve`, `web/app/api/internal/copilot-studio` |
| 13 | [learner-portal.md](learner-portal.md) | What a learner sees: the org home, the twin page (`/t/…`), the practice link (`/s/…`), minutes shown, out-of-minutes, switch account | `web/lib/pages/*`, `web/app/(org)/*`, `web/components/org/*`, `web/components/session-view.tsx` (learner parts), `web/components/session/*` |
| 14 | [voice-agent-and-chat.md](voice-agent-and-chat.md) | The two runtimes behind a call: the LiveKit voice agent (Python) and the chat brain (eve): session modes, prompts, deadline and goodbye, webhook back | `agent/src/*`, `chat/agent/*`, `chat/prompts/*`, `agent/tests`, `chat/tests` |
| 15 | [platform.md](platform.md) | Shared plumbing: uploads to S3 and their expiry, usage tracking, issue reports, crons, analytics, deploys and environments | `web/lib/uploads.ts`, `upload-*.ts`, `s3.ts`, `usage.ts`, `issue-alerts.ts`, `posthog-server.ts`, `web/vercel.json`, `web/scripts/vercel-build.sh`, `web/app/api/internal/*`, `web/app/api/upload*` |
| 16 | [billing.md](billing.md) — rule spec | Agreed rules: Trial/Paid, tax-inclusive prices, billing details, invoice/receipt emails, packs, pauses and release checks | `specs/billing.md` Rules and Checks |
| 17 | [billing-code.md](billing-code.md) — module spec | Phase 2 + 3 code: Meteroid subscriptions/top-ups, Razorpay invoice links/payments/fees, invoice workflows/emails/receipts, daily repairs, studio UI and pause gates | `web/lib/billing/*`, `web/lib/razorpay.ts`, `web/workflows/invoice-{issued,paid}.ts`, `web/app/api/{meteroid,razorpay}/webhook/route.ts`, `web/components/billing/*`, `web/scripts/billing-fee-report.ts` |
