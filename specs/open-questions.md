# Open questions and mismatches, all modules

Collected verbatim from each spec's *Mismatches* and *Open questions* sections, for the product owner to decide.
Each answer should land back in the module's spec (and become a test or a fix). Regenerate after editing specs.

## [Authentication and host routing](auth.md)

### Mismatches

- **People rule 10, remaining plugin reset routes:** the six base password paths are now 404, but disabledPaths matches exact normalized paths. Email-OTP still registers `/email-otp/request-password-reset`, `/forget-password/email-otp` and `/email-otp/reset-password`, none listed there. Requests can store a forget-password code; the callback sends no reset email. With a valid stored code, the plugin reset handler can write a credential password even with emailAndPassword disabled. This is not an enabled password sign-in route (`web/lib/auth.ts` `auth`, `sendVerificationOTP`; `web/node_modules/better-auth/dist/api/index.mjs:166–169`; `dist/plugins/email-otp/routes.mjs:464–598` `requestPasswordResetEmailOTP`, `forgetPasswordEmailOTP`, `resetPasswordEmailOTP`; `web/app/api/auth/[...all]/route.ts`).
- Historical plan §8 says first sign-in creates an account; agreed rule 10 and current disableSignUp refuse it. Founder account comes from script instead (`plans/people-and-sign-in.md`; `web/lib/auth.ts`; `web/scripts/founder-invite.ts`).
- Disabled copy says no sign-in, but all-disabled check permits other enabled orgs; cache can preserve identity temporarily (`web/lib/members.ts`; `web/lib/auth.ts`).
- Founder UI promises 3–30-character slug, while server regex also accepts one character. Founder script refuses existing accounts although onboarding page/API support another org for an existing founder; its “send an invite from dashboard” error is stale because member invitations are refused (`web/lib/slugs.ts`; `web/scripts/founder-invite.ts`; `web/app/api/onboarding/route.ts`).

### Open questions

- How should an operator issue another founder token to an existing account? Script refuses it, API accepts its session/token (`web/scripts/founder-invite.ts`; `web/app/api/onboarding/route.ts`).
- Should workspace POST retry after name save, and token consumption be conditional in-transaction? Current form/route allow skipped retries and concurrent consumption (`web/components/auth/founder-form.tsx`; `web/app/api/onboarding/route.ts`).
- None about password policy, invitation acceptance or Google linking to pre-created unverified accounts: [People](people.md) decides them.

## [Organizations and roles](orgs-and-roles.md)

### Mismatches

- **People rule 5:** direct membership reads remain outside the service: `web/lib/org.ts:66` (enabledMemberships), `web/lib/members.ts:30,58` (disabled/elsewhere checks), `web/app/auth/onboarding/page.tsx:43` (admin memberships). These are account-own cross-org reads, explicitly allowlisted by `web/tests/lib/org-people-architecture.test.ts:13`, rather than the rule's unconditional one-service boundary.
- **People rules 1, 5–7, 9, 11–12 and assignment check:** `web/scripts/set-member-role.ts:22,31,42,44` reads/creates members directly, requires an existing account, skips starting credits/email, creates a new admin without the second-admin check, can demote the existing admin and promotes without dropping assignments. `web/scripts/seed-mock-sessions.ts:197` also directly adds learners without grants/email. These scripts are outside the architecture test's member-read scan.
- **People rule 5:** direct org-person reads remain in scripts: `web/scripts/api-contract-check.ts:93,95`, `web/scripts/session-isolation-check.ts:13,36`, `web/scripts/charge-past-sessions.ts:33`, `web/scripts/simulate-conceptual-understanding.ts:50`. The contract-check script also directly inserts a learner at `:101` (rules 6, 9, 11–12); isolation check directly assigns its first arbitrary member at `:20`, without a learner-role check (rule 7).
- **People rule 7:** admin checks precede writes without serialization (`web/lib/org-people.ts:137–153`; `web/lib/members.ts:19–20`; `web/lib/auth.ts:69–74`). Concurrent additions/promotions can create two admins. The migration's INSERT also checks pre-statement admins, so multiple pending admin invitations in an admin-less org can backfill multiple admins (`web/prisma/migrations/20261111120000_people_first/migration.sql:38–46`).
- **People rule 8 / no-studio-assignment check:** disabled/studio validation precedes independent credit/member/assignment writes. Concurrent disable/promotion can pass the old check and then receive a new assignment (`web/lib/org-people.ts:128–153`; `web/lib/invite/twin.ts:24–32`; `web/lib/invite/roleplay.ts:29–60`). No assignment-role/disabled DB constraint closes this race.
- **People learner-ledger check:** grants commit before accounts/members (`web/lib/org-people.ts:143–153`; `web/lib/minutes.ts:176–178`). Later failure can leave a grant without a member and part of a batch added; shortage itself does correctly add nobody.
- Historical plans still describe first-call membership, email assignments and invitations. Those are superseded by [People](people.md); common twin links now join on page opening, not call start (`plans/people-and-sign-in.md`; `web/lib/pages/learner.ts` `loadSharedSession`; `web/lib/interview-sessions.ts` `activateSession`).
- Existing broader UI/plan mismatches remain: users-only-practise versus legacy protected loaders; hideRoleplay copy versus partial gating; disable copy versus multi-org login; slug's 3–30 copy versus one-character server regex (`web/lib/pages/router.ts`; `web/lib/org.ts`; `web/components/users/team-section.tsx`; `web/lib/slugs.ts`).

- **People rule 5:** raw authorization lookup in `web/lib/notion-oauth.ts:84–94` joins member directly instead of orgPerson. Benchmark/simulation scripts also read org members directly: `web/scripts/opening-warm-ab.ts:21`, `chat-completions-bench.ts:210`, `cerebras-30-quality.ts:55`, `model-turn-latency.ts:57`, `simulate-15-turns.ts:106`, `benchmark-30-turns.ts:125`. The architecture regex misses raw SQL and findFirstOrThrow, and its member-read roots exclude scripts (`web/tests/lib/org-people-architecture.test.ts`).
- **People rule 5:** some assignment-learner displays still obtain identity from nested assignment user/member reads rather than orgPeople: twin library cards (`web/lib/twin/trpc.ts:205–231`), copilot role-play get (`web/lib/copilot-studio.ts:151–162`), legacy preview assignment summaries (`web/lib/pages/role-play-preview.ts:14–34`). Preview uses orgPeople for its picker, but not these summaries; the member-only architecture regex does not catch assignment-derived lists.

### Open questions

- Should learners' legacy overview/knowledge/voice access be removed? `plans/twin-roleplay-db-split.md` §13 versus `web/lib/pages/router.ts` and legacy knowledge/TTS routes.
- Is hideRoleplay a discovery flag or a complete feature restriction? `web/lib/org.ts` `requireRoleplayOrg` versus `web/lib/roleplay/trpc.ts` and public catalog.
- Should used role-play links and creator API keys be revoked on disable? `web/lib/members.ts` preserves both; `web/lib/external-api.ts` does not globally re-check creator membership.
- How is admin transfer/recovery performed? Better Auth cannot change an admin; `web/scripts/set-member-role.ts` bypasses this (`web/lib/auth.ts`).

## [People and emails](invites-and-emails.md)

### Mismatches

- **People rule 12:** `web/lib/org-credits-email.ts:22–37` loops inline inside one announce step, not one retryable step per email; a failure delays later grants and retries the whole loop (`web/workflows/steps/org-credits.ts:19–22`).
- **People rule 11:** `web/lib/org-credits-email.ts:19–40` marks grants announced with no enabled admin or missing Resend, despite sending no email; later sync will not deliver them. Concurrent announce runs can also reread the same IDs; Resend deduplication lasts only 24 hours (`web/lib/email.ts:16`).
- **People learner-ledger check:** starting grants commit before account/member writes; later persistence failure can leave orphan ledger rows and no added email (`web/lib/org-people.ts:143–159`; `web/lib/minutes.ts:176–178`). Details and script bypasses: [Organizations and roles — Mismatches](orgs-and-roles.md#mismatches).
- Historical `plans/people-and-sign-in.md` §8 says first sign-in creates an account; agreed People rule 10 and current disableSignUp instead refuse unknown accounts (`web/lib/auth.ts`). Users and assignment guides/OpenAPI now describe immediate members and Google/email-code sign-in. The assignment guide's old email subject still differs from personEmail (see [Public API — Mismatches](public-api.md#mismatches); `docs/guides/assignments.mdx`; `web/lib/email.ts` `personEmail`).

- **People rule 11 (at most once per event):** delivery has Resend's 24-hour deduplication only, not a durable sent-event record (`web/lib/email.ts:16`; `web/workflows/steps/send-emails.ts:20`; `web/lib/queue-emails.ts:19,29`). Repeating a lost-response send after that window can deliver the same event again.

- **People rule 11:** existing members newly given their first starting grant can get no email when add/assignment skips them: addedEmails filters added=true (`web/lib/invite/org.ts:22–23`), twin mail only covers new/reactivated access (`web/lib/invite/twin.ts:33–46`), and roleplay pending/used skips (`web/lib/invite/roleplay.ts:67–69`). addPeopleToOrg grants to all requested learners without prior grants, not just fresh members (`web/lib/org-people.ts:145`). This is reachable for backfilled or directly seeded members lacking grants.

### Open questions

- Should final delivery progress be available to REST and inside copilot? REST returns immediate emailSent only; copilot reports background sending but does not follow the token (`web/lib/queue-emails.ts` `deliverEmail`; `web/lib/copilot-studio.ts` `emailsStatus`).
- None about invitation acceptance, passwords, staff-recipient assignment or first-use member binding: [People](people.md) has decided those rules. Listed mismatches are code bugs, not decisions to reopen.

## [Credits](credits.md)

### Mismatches

- **People account/member ordering and learner-ledger check:** `web/lib/org-people.ts:143–153` commits starting grants before creating accounts/members; `web/lib/minutes.ts:176–178` has no membership FK/check on these email ledger rows. A later failure leaves an orphan grant/partial batch. Credit shortage itself correctly adds nobody.
- **People rule 11:** org-credit grants are marked announced even without an admin or Resend (`web/lib/org-credits-email.ts:19–40`). **Rule 12:** the announce loop is one retryable step, not one per grant email (`web/workflows/steps/org-credits.ts:19–22`). REST immediate delivery and workflow-startup fallback are allowed exceptions with the original event keys (`web/lib/queue-emails.ts` `deliverEmail`, `queueEmails`); the announce loop is not one of those exceptions.

Legacy ledger rows and some comments still mention top-ups/take-backs. They do not make the ledger the org balance or expose current refund/reclaim helpers (`web/prisma/schema.prisma`; `web/lib/minutes-config.ts`; `web/components/credits/credits-history-table.tsx`).

### Open questions

- Refunds do not take credits back. Operators must adjust Meteroid by hand; when should this be automated? (`web/lib/credit-purchases.ts` `purchaseRefunded`.)
- The Credits plan sets overage to 0.25/min if usage exceeds credits. The app intends to stop at zero; should overage ever be collectible? (`web/scripts/meteroid-setup.ts` `OVERAGE_PER_MINUTE`.)
- Simultaneous call starts are not serialized with grants. Must the available balance reserve whole call allowances rather than elapsed usage? (`web/lib/interview-sessions.ts` `activateSession`; `web/lib/org-credits.ts` `runningSeconds`.)

## [Payments](payments.md)

### Mismatches

Legacy refund status/total fields remain but are not updated by current refund handling. Script refund-days option remains although it has no effect (`web/prisma/schema.prisma`; `web/scripts/reconcile-purchases.ts`; `web/lib/credit-purchases.ts`).

### Open questions

- Refunds do not take credits back; operators must adjust Meteroid manually. When should automatic reversal and refund accounting return? (`web/lib/credit-purchases.ts` `purchaseRefunded`.)
- Credits plan overage is 0.25/min if usage exceeds credits; the app intends not to permit this. Confirm collection policy (`web/scripts/meteroid-setup.ts`).
- Linking checks invoice status/currency, not tax fields. GST classification is the operator's responsibility (`web/lib/razorpay.ts` `RazorpayInvoice`; `web/lib/credit-purchases.ts` `linkInvoicePurchase`).

## [Twins](twins.md)

### Mismatches

- Role/disable races and operator scripts can leave studio assignments despite normal assignment rejection; see [Organizations and roles — Mismatches](orgs-and-roles.md#mismatches) (People rules 7–8).

| Intent / older description | Code today |
| --- | --- |
| `PRODUCT.md` describes Agent/Domain compilation, immutable human-approved publishing and a deterministic interview/Pipecat runtime. | Main creation makes only an Agent; twin-creator publication directly updates a TWIN and snapshots old content. Neither endpoint requires a separate human-approval/change-summary step. The twin prompt has no interview agenda and uses the LiveKit/chat path. (`web/lib/twins.ts` `ensureTwin`; `web/app/api/internal/twin-skills/route.ts`; `web/lib/scenario-ingest.ts`; `chat/prompts/twin.md`; `web/lib/interview-sessions.ts`.) |
| `plans/twin-content-inventory.md` says main creation includes a Domain, playbooks are live/unpinned, and calibration does not exist. | No Domain creation; new calls pin skill versions; calibration tables/UI exist. (`web/lib/twins.ts`; `web/lib/interview-sessions.ts`; `web/lib/twin/trpc.ts`.) |
| `plans/twin-roleplay-db-split.md` and comments in `web/prisma/schema.prisma`/`web/lib/twin-access.ts` describe per-twin minutes and no expiry. | `accessUntil` gates starts. Credits are per learner across the org; `minutesLimit`/`minutesPerUser` are legacy. REST still validates these misleading fields. (`web/lib/twin-access.ts` `usable`, `DEFAULT_TWIN_MINUTES`; `web/app/api/twins/[slug]/share-links/route.ts`; see [Credits](credits.md).) |
| `plans/twin-share-link.md` says `/t/` needs an active common link and grants access on join, using sign-in pages. | `/t/` is a public profile with in-page Google sign-in and existing-assignment access. Share creates nothing. Only legacy `/s/` common codes join. Short/full skill paths both resolve, rather than only the original full-slug proposal. (`web/lib/pages/learner.ts`; `web/lib/twin-access.ts`; `web/components/twin/twin-learner-flow.tsx`; `web/lib/twin/trpc.ts` `agents.shareLink`.) |
| `plans/twin-skill-ingest.md` proposes a separate Chroma `twin` collection and a Skills card on the brain. | Items are in org collection `main`; brain still shows static Coaching style. Create-skill handoff lives in the library. (`web/lib/main-collection.ts` `getCollection`, `writeScenarioItems`; `web/components/twin/twin-brain-page.tsx`; `web/components/twin/twin-agents-page.tsx`.) |
| `plans/twin-roleplay-db-split.md` says re-ingested examples are always latest, most-asked is untracked and settings not applied. `plans/twin-session-processing.md` describes `after()` report scheduling. | Examples are version-tagged with fallback; report-derived Most asked/Couldn't answer are present; before settings are enforced. Twin reports use Workflow. (`web/lib/main-collection.ts`; `web/lib/twin/trpc.ts`; `web/lib/context-upload.ts`; `web/lib/interview-sessions.ts`; `web/lib/session-close.ts`.) |
| `plans/twin-wiring-and-reliability.md` says final-transcript timeout must not produce a report from provisional text. | Workflow waits up to twelve 10-second checks, then generates using the saved transcript even without `transcriptFinal`. (`web/workflows/end-twin-session.ts`; `web/workflows/steps/twin-session-report.ts` `generateTwinReport`.) |
| Earlier split plan says ratings do not feed prompts; boundary plan says not a role play. | Calibration feedback changes the rest of that call, not future skills. The twin prompt permits rehearsal if the learner explicitly asks. (`chat/prompts/twin-calibration.md`; `chat/prompts/twin.md`; `plans/twin-boundary-and-unanswered.md`.) |
| Learner summary says remaining minutes are “with this twin.” | Balance is org-wide, shared with all twins/role plays. (`web/components/twin/twin-learner-flow.tsx` `Summary`; `web/lib/pages/learner.ts` `twinAccessFor`.) |

### Open questions

1. Should main-twin detail show **only its persona's skills and Built from sources**? Runtime `pinTwinSkills` filters by persona; `agents.get` currently fetches all non-main live twins in the org for its skills/source display. (`web/lib/twins.ts`; `web/lib/twin/trpc.ts` `agents.get`.)
2. May a main twin be archived? Copilot rejects it, generic spec DELETE allows it, and the skill-card Remove button does nothing. Which surface should tests treat as the intended user action? (`web/lib/copilot-studio.ts` archive; `web/lib/specs.ts` `deleteSpec`; `web/components/twin/twin-agents-page.tsx`.)
3. Must an archived skill disappear from an already pinned call? `twinPlaybooks` says deleted skills are dropped and queries only live rows, but can still restore their saved `SpecVersion` data even without a live row. Existing tests cover a missing skill **without** a retained snapshot, not that case. (`web/lib/twins.ts` `twinPlaybooks`; `web/tests/lib/twin-playbooks.test.ts`.)
4. How should active-but-expired access be extended? Assignment APIs skip active rows; PATCH changes only status. Currently revoke then reassign can set a new date, but Configure has no revoke/date-edit control for existing assignments. (`web/lib/twin-access.ts` `assignTwin`, `updateTwinAssignment`; `web/components/twin/twin-edit-page.tsx`.)
5. Can ending immediately after start miss the calibration marker? `CalibrationCall.start` starts the calibration write without awaiting it; `end` waits rating writes, not that creation promise, and reads the current calibration ID. Ratings are disabled meanwhile, but the call may finish without navigating to a saved calibration. (`web/components/calibration/calibration-call.tsx` `start`, `end`; `plans/twin-wiring-and-reliability.md`.)

## [Role plays](roleplays.md)

### Mismatches

- Normal assignment paths follow People rules 3–4 and refuse staff/disabled members; concurrent role/disable changes and direct operator writes remain exceptions to rules 7–8. See [Organizations and roles — Mismatches](orgs-and-roles.md#mismatches) (`web/lib/org-people.ts`; `web/lib/invite/roleplay.ts`; `web/scripts/set-member-role.ts`).

| Intent, history or copy | Code today |
| --- | --- |
| **Stale one-attempt/30-day assumptions:** `plans/roleplay-preservation.md` B, `plans/roleplay-skill.md` access paragraph, `web/prisma/schema.prisma` comment above `TwinAssignment`, and the comment above `sendPersonEmail` / `personEmail` in `web/lib/email.ts`. | Pending/used links allow repeat calls, expiry timestamps are ignored. Actual email content says unlimited repeats while minutes last. `web/lib/interview-sessions.ts` `activateSession`; `web/lib/pages/learner.ts` `loadSharedSession`; `web/lib/email.ts`. |
| **Stale rejection copy:** `/s/<code>` says invalid links may have expired or already been completed; activation returns “Invalid or already used session URL”. | A past date or a used/completed practice is no longer a reason to reject. Stored status `expired` still blocks. `web/app/(org)/s/[code]/page.tsx`; `web/app/api/sessions/route.ts`; `web/lib/interview-sessions.ts`. |
| Plans say “rubric = 100” and promise a test for it (`plans/roleplay-preservation.md`, `plans/roleplay-skill.md`). | Schema only bounds each criterion; any positive total is allowed and normalized to 100 by the report. The default sales rubric totals 100, but that is a preset. `web/lib/roleplay/skill.ts`; `web/lib/roleplay/session-report.ts`; `web/components/roleplay/roleplay-builder-page.tsx`. |
| `plans/roleplay-skill.md` puts recording ingestion, copilot changes and builder assistant under “Later”. | Copilot ingestion already accepts `kind = ROLEPLAY`, and `updateRoleplay` handles non-builder settings. No builder-assistant flow is exposed in the inspected builder. `web/lib/scenario-ingest.ts` `scenarioIngestSchema`, `ingestScenario`; `web/lib/roleplay/manage.ts`; `web/components/roleplay/roleplay-builder-page.tsx`. |
| `PRODUCT.md` says publishing requires explicit approval and a visible change summary, and published Agents pin a persona version. | Builder save publishes directly, with no distinct approval/summary gate. Agent holds a live persona ID; persona version/data are pinned when a session starts, not when the Agent is published. Settings can mutate without a new Agent version. `web/lib/roleplay/trpc.ts` `builder.save`, `builder.saveSettings`; `web/lib/scenario-ingest.ts`; `web/prisma/schema.prisma`; `web/lib/interview-sessions.ts`. |
| `PRODUCT.md` describes conversation-first Agent/Domain specs and a Pipecat/deterministic runtime. | The builder is a deterministic form-to-skill renderer; current activation initializes chat and LiveKit. Older interview generation still uses an LLM and drafts. Runtime detail belongs to [Voice agent and chat](voice-agent-and-chat.md). `web/lib/roleplay/skill.ts`; `web/app/api/agents/[slug]/generate/route.ts`; `web/lib/session-activation.ts`. |
| `plans/roleplay-workspace-tools.md` describes role-play Tools generally, but excludes `/agents`. | Only builder-source agents load through `builder.get/saveSettings`; old interviews without `data.tools` default to all workspace surfaces off. `web/lib/roleplay/trpc.ts` `findRoleplay`; `web/lib/agent-tools.ts`; `chat/agent/tools/workspace.ts`. |
| Expiry remains a required field and new assignments still get 30-day dates. | Dates are compatibility data, not a running access timer. Current API docs explicitly describe repeat practice and historical expired statuses, matching activation. `web/lib/assignments.ts`; `docs/guides/assignments.mdx`; `docs/openapi.yaml` `AssignmentStatus`; `web/lib/pages/learner.ts`. |

### Open questions

- Should ingestion-created ROLEPLAY skills be first-class runnable role plays? `ingestScenario` writes `source = scenario-ingest` and requires an own persona; the runtime recognizes any ROLEPLAY with `data.skill`. But `isRunnableAgentData` recognizes skill-only role plays only for `roleplay-skill`, and the library routes every other source to the old interview editor. No `after.report = roleplay` is added by this ingest path. Pointers: `web/lib/scenario-ingest.ts` `ingestScenario`, `buildScenario`; `web/lib/specs.ts` `isRunnableAgentData`; `web/lib/roleplay/trpc.ts` `scenarios.list`; `chat/agent/lib/roleplay.ts` `roleplaySkill`; `web/lib/session-after.ts`.
- Is `hideRoleplay` meant only to hide discovery, or to revoke access? Page/sidebar/home guards enforce hiding, but the tRPC router, assignment APIs, public catalog and existing `/s/` links do not consult the flag. Pointers: `web/lib/org.ts` `requireRoleplayOrg`; `web/lib/pages/org-home.ts`; `web/lib/roleplay/trpc.ts`; `web/app/api/portal/agents/route.ts`; `web/lib/pages/learner.ts`.
- Should Roleplay users and detail member lists exclude cancelled/expired assignments and archived agents? The new `invitesFor` queries include them, whereas older `listSpecSummaries` counts only pending/used assignments. Pointers: `web/lib/roleplay/trpc.ts` `users.list`, `scenarios.get`, `invitesFor`; `web/lib/specs.ts` `listSpecSummaries`.

## [Sessions](sessions.md)

### Mismatches

- The membership-check comment still says a common twin link added the member earlier in activation. The actual twin access call passes join=false; page opening is the join point (`web/lib/interview-sessions.ts:249,367–371` `activateSession`; `web/lib/pages/learner.ts` `loadSharedSession`).

- `PRODUCT.md` names Pipecat and the synthesizer deterministic runtime as the published voice path. Current web activation creates LiveKit dispatches and initializes the separate chat service; the voice agent uses LiveKit (`web/lib/session-activation.ts`, `web/lib/interview-sessions.ts`, `agent/src/agent.py`). The web deterministic adapter still exists separately in `web/lib/runtime/openai.ts`.
- Old plans describe separate twin/roleplay report workflows and best-effort v1 after() scheduling. Current two end workflows close, charge and claim all report kinds; v1 uses writeSessionReport with one retry (`web/lib/session-end.ts`; `web/workflows/end-roleplay-session.ts`; `web/workflows/steps/session-end.ts`).
- `plans/twin-wiring-and-reliability.md` says not to generate from a partial transcript after a bounded wait. Both current workflows fall through after 12 waits and generate from whatever was saved (`web/workflows/end-twin-session.ts`, `web/workflows/end-roleplay-session.ts`).
- That reliability plan asks for missing/stale workflow recovery and retryable enqueue errors returned to producers. Current end routes log report-start failure and return success; twin polling only handles explicit failed/cancelled run status (`web/app/api/sessions/webhook/route.ts`, `web/app/api/sessions/finalize/route.ts`, `web/app/api/sessions/route.ts` PATCH, `web/lib/twin/trpc.ts`).
- `plans/roleplay-skill.md` says access is “one attempt, 30 days.” Activation accepts used assignments and ignores expiry timestamps; repeat practice is limited by minutes. `web/tests/lib/assigned-activation.test.ts` explicitly covers resume past expiry (`web/lib/interview-sessions.ts`).
- The recording-upload route comment says Pipecat, but the current voice entrypoint is LiveKit and does not call the old audio/video egress helpers (`web/app/api/sessions/recording/route.ts`, `agent/src/agent.py`, `agent/src/recording/egress.py`).

### Open questions

1. **Should end-status webhooks populate dedicated audio playback?** The webhook constructs `s3AudioKey`, but passes it to `closeInterviewSession`, whose forwarding only includes transcript/evidence/replaceTranscript. A no-status webhook calls `finalizeInterviewSession` directly and can save it. Audio playback reads only the dedicated column, not evidence's `audioS3Key` (`web/app/api/sessions/webhook/route.ts`, `web/lib/session-lifecycle.ts`, `web/app/api/sessions/[id]/audio/route.ts`).
2. **What are the required idempotency and owner guarantees?** Direct deployment keys include deployment and caller-supplied idempotency key, not user ID. The existing-row lookup/resume does not check owner/org again, nor is lookup/create serialized. Should cross-user reuse and parallel-start conflicts be refused explicitly? (`web/lib/interview-sessions.ts` `activateSession`; unique `activationKey` in `web/prisma/schema.prisma`).
3. **Should late agent endings revive revoked/failed sessions?** `resolveSessionEndStatus` protects only completed; an authenticated webhook can move another previous status to completed/abandoned, retaining its first end time (`web/lib/interview-sessions.ts`, `web/app/api/sessions/webhook/route.ts`, `web/lib/members.ts`).
4. **Which report selection must remain pinned?** Dispatch and webhook transcript policy inspect current agent data, but role-play report input prefers pinned data. Editing `after.report` between start and end can therefore change routing or readiness expectations (`web/lib/session-close.ts`, `web/app/api/sessions/webhook/route.ts`, `web/lib/roleplay/session-report.ts`).
5. **Is a marker without transcript enough for final readiness?** For workflow report kinds, an authenticated webhook sets `transcriptFinal` even if it supplies no nonempty transcript. The workflow treats that marker as ready and may use the browser's transcript (`web/app/api/sessions/webhook/route.ts`, `web/workflows/steps/twin-session-report.ts`, `web/workflows/steps/roleplay-session-report.ts`).

## [Knowledge](knowledge.md)

### Mismatches

| Intent / description | Current code |
| --- | --- |
| `PRODUCT.md`: Chroma/OpenRouter hybrid retrieval | Org main search is vector-only, optionally reranked. BM25/RRF remains only on no-org legacy collection search. (`web/lib/knowledge.ts`, `web/lib/main-collection.ts`.) |
| `plans/prod-release-v2.md` §2D and `plans/twin-skill-ingest.md`: uploads store original + Markdown, indexing paused | Current ordinary upload saves the original and queues Python conversion/redaction/indexing. Without queue config it keeps only the original until retried; the older named-KB upload still saves two copies and queues the incompatible old job. (`web/lib/org-knowledge.ts`, `web/lib/specs.ts`, worker.) |
| `plans/twin-skill-ingest.md`: move skill items to a separate `twin` collection | `MainCollectionService` still writes/searches `scenario_item` in org `main`; the release plan explicitly calls the separate collection on hold. (`web/lib/main-collection.ts`, `plans/prod-release-v2.md`.) |
| `plans/copilot-v2.md`: add soft deletion for knowledge documents and retain S3 | There is no `KnowledgeDocument.deletedAt`; all document/source/base deletion helpers hard-delete rows and attempt artifact deletion. (`web/prisma/schema.prisma`, `web/lib/org-knowledge.ts`, `web/lib/connectors.ts`, `web/lib/specs.ts`.) |
| `plans/chat-twin-roleplay.md`: hide raw knowledge search from twins; `plans/uploads-to-s3.md` says knowledge reads are off in role plays | Current knowledge tools block only `roleplay-client`; interview role plays and twins pass that guard. Their material/prompt choices are separate from permission enforcement. (`chat/agent/tools/{search_knowledge,read_knowledge_document}.ts`, `chat/agent/lib/session-mode-lookup.ts`.) |
| Drive UI and import-route comment say no queue/indexing and separate saved Markdown | Drive now calls `OrganizationKnowledgeService.uploadDocument`, which queues processing when configured; immediate Markdown is not saved there. Repeat detection still only accepts `uploaded`. (`web/components/knowledge/google-drive-import.tsx`, `web/app/api/connectors/google-drive/import/route.ts`, `web/lib/org-knowledge.ts`.) |
| Notion API offers accepted imports/refresh; durable jobs and UI counters imply connector processing | Notion sends `{jobId, workItemId}`; current Python worker requires a file/fetch payload. No current connector handler consumes these jobs. YouTube now bypasses those jobs, although overview/list helpers still read old job/segment counters. (`web/lib/notion-ingestion.ts`, `web/lib/ingestion-queue.ts`, `web/lib/youtube-ingestion.ts`, worker, `ingestion/README.md`.) |
| Upload UI offers only a short document list | Server supports many more formats including media/images. Both add-source dialog and upload modal restrict their file pickers to smaller lists. (`web/components/knowledge/knowledge-add-source-dialog.tsx`, `knowledge-upload-modal.tsx` in the same directory; `web/lib/documents.ts`.) |

### Open questions

1. Which old-style queue consumers, if any, run outside this repository? Notion and named-KB upload/digest enqueue identifier-only work, but `ingestion/src/ingestion/worker.py` rejects it and `ingestion/README.md` says the old TypeScript worker was removed. What user-visible Notion status should represent this gap? (`web/lib/notion-ingestion.ts`, `web/lib/specs.ts`, `web/lib/ingestion-queue.ts`.)
2. Should knowledge management and original previews be learner-accessible? `getSessionOrg` protects read routes and the catch-all's writes, while current uploads/source management use `getTrainerOrg`. `page.twinKnowledge` is also only `protectedProcedure`. (`web/app/api/knowledge/[[...kb]]/route.ts`, document preview route, upload route, `web/lib/pages/router.ts`.)
3. Which KB selection is authoritative for Eve sessions? Compiled config uses agent selections/all indexed org bases; `buildSessionContext`, `search_knowledge` and project prefetch hard-code `acme-knowledge`. Full reads check org/indexed status only. (`web/lib/specs.ts` `getAgentConfigForAgent`, `web/lib/session-context.ts`, `chat/agent/tools/search_knowledge.ts`, `chat/agent/lib/project-knowledge.ts`, `web/app/api/copilot/studio/route.ts`.)
4. Should source/base deletion clean current-format originals and worker output too? Document deletion enumerates all three layouts; source/base deletion only removes `kbPrefix`. This leaves current YouTube artifacts outside source-disconnect cleanup. (`web/lib/org-knowledge.ts` `deleteDocument`, `web/lib/connectors.ts` `deleteSource`, `web/lib/specs.ts` `deleteKnowledge`, `web/lib/youtube-ingestion.ts`.)
5. How should overlapping reindexes and deletion during result writes be resolved? Deterministic chunk IDs make same-run retries overwrite safely, but there is no generation check, completion transaction or first-run partial-vector cleanup guarantee. (`web/lib/org-knowledge.ts` `reindexDocument`, `deleteDocument`; results route; `web/lib/main-collection.ts`.)
6. Can another trainer reconnect an existing workspace/channel? Both OAuth save paths can encrypt with the previous connection user's binding and then overwrite `userId` with the new user; later decryption binds to the stored user. What should happen on cross-user reauthorization or reuse of an old refresh token? (`web/lib/notion-oauth.ts` `saveNotionConnection`, `web/lib/youtube-oauth.ts` `finishYouTubeOAuth`, `shared/youtube/tokens.server.ts`.)
7. Should Notion imports accept a caller-provided `kbId` without verifying org ownership? The schema permits it and `queueNotionSync` only org-checks a KB resolved by slug; OAuth state consumption separately enforces KB ownership. (`web/lib/notion.ts`, `web/lib/notion-ingestion.ts`, `web/lib/notion-oauth.ts` `consumeNotionOAuthState`.)

## [Personas and voice](personas-and-voice.md)

### Mismatches

- `PRODUCT.md` describes immutable published persona versions, explicit human approval, and a default persona choice. Persona form/YAML saves and automatic synthesis update live persona data directly; no persona publish/default field exists. Sessions pin data, but media/settings remain mutable and unversioned (`web/lib/personas.ts`; `web/lib/specs.ts`; `web/lib/persona-synthesis.ts`; `web/prisma/schema.prisma`).
- `plans/persona-fields.md` begins with five looks, eight roles, persona difficulty, and pace in the prompt. Current code uses independent media, expanded client/interviewer/coach role groups, removes knowledge/difficulty on form save, and stores pace separately with no brief/TTS effect. Its later media model and difficulty/long-answer decisions match these newer paths (`web/lib/persona.ts`; `web/lib/persona-media.ts`).
- `plans/persona-in-chat.md` P2 is implemented: own persona identity only, selected by `isOwn`, not agent kind. Its older opening statement that chat drops editor fields is historical; current web emits meanings and chat consumes the brief (`web/lib/persona.ts` `personaBrief`; `web/lib/session-context.ts`; `chat/agent/lib/brain.ts`).
- Twin voice UI says “Your twins speak with it now.” The worker now speaks that saved voice ID through VoxCPM2. No browser test covers a live call using the saved voice (`web/components/twin/twin-voice-capture.tsx`; `agent/src/tts/voxcpm2.py`).
- Default-voice comments say “shared sample voices,” but the query checks only global and ready, not kind. Voice-resolver comments describe version-driven cache updates; current `VoiceStore` caches URL/transcript by TTL and discards version (`web/app/api/tts/default-voice/route.ts`; `tts/app/voices.py`).
- Persona page comments suggest global personas fall back to a spec page, but `loadSpecResource` requires an org-scoped row and `readSpec` also reads that scope. Global persona resolution is supported for agent/session use, not this page path (`web/app/dash/personas/[slug]/page.tsx`; `web/lib/pages/router.ts` `persona`; `web/lib/pages/spec-resource.ts`; `web/lib/specs.ts` `readSpec`, `findOrgOrGlobalPersona`).

### Open questions

1. Should learner-role members be allowed to create/rename/delete org voices, and should speech proxy/default voice be public? Persona writes use studio checks, while voice management uses any membership and speech/default handlers have none (`web/app/api/personas/route.ts`; `web/app/api/tts/voices/route.ts`; voice-ID, speech, and default-voice routes).
2. Is global single-flight required under concurrent drains? The queue comment promises it, but the transaction does not lock a shared slot or serialize the active check (`web/lib/persona-analysis-queue.ts` `claimNextPersonaSource`).
3. Should historical baselines/media reflect the shown version? Historical YAML uses `readVersion`, but the baseline is current and SpecVersion contains only data, not media/settings (`web/lib/pages/spec-resource.ts`; `web/lib/persona-baseline.ts`; `web/prisma/schema.prisma`).
4. Is deleting a persona-owned voice from the general library intentional? The route permits it, the FK clears `Persona.voiceId`, and agent JSON overrides remain stale until session fallback handles them (`web/app/api/tts/voices/[voiceId]/route.ts` DELETE; `web/prisma/schema.prisma`; `web/lib/session-activation.ts`).
5. Should TTS `/v1/voices` work server-to-server? It forwards the service secret to the web collection endpoint, but that endpoint requires a browser org session rather than `TTS_APP_KEY`, unlike the individual resolver (`tts/app/main.py` `voices`; `tts/app/voices.py` `list_ids`; `web/app/api/tts/voices/route.ts` GET).

## [Public API](public-api.md)

### Mismatches

- **People ledger check:** starting grant precedes member creation and can be orphaned by later DB failure (`web/lib/org-people.ts:143–153`). This shared implementation issue is detailed in [Organizations and roles](orgs-and-roles.md). REST immediate email delivery with emailSent and the same event key is allowed by People rule 12 (`web/lib/queue-emails.ts` `deliverEmail`).

Reference scope: existing docs audit, with the people-sensitive OpenAPI/User/Assignment guide sections rechecked against current code for this update. No published build/site or inbox claim. The following are discrepancies or missing contract details, not proposed changes.

### Published reference and guides versus implementation

| # | Documentation / other claim | Code today |
| --- | --- | --- |
| 1 | `docs/authentication.mdx`: every `/api/v1` request needs an org API key; `docs/index.mdx`: all responses JSON except 204; OpenAPI/Postman enumerate the integrator paths only. | POST `/api/v1/chat/completions` exists but is undocumented there, uses runtime tokens and defaults to SSE. Thus the blanket auth/format claims do not cover every route under the prefix (`web/app/api/v1/chat/completions/route.ts`, `web/lib/runtime/openai.ts`). |
| 2 | `docs/authentication.mdx`: permissions are read/write users/assignments, read sessions/scenarios. | New keys also store `sessions:write`, although no handler uses it (`web/lib/auth.ts` `defaultPermissions`). |
| 3 | `docs/limits.mdx`, `authentication.mdx`, `errors.mdx`, OpenAPI `RateLimited`: over limit returns 429. | Installed plugin emits `RATE_LIMITED`; wrapper tests only `RATE_LIMIT_EXCEEDED`, so plugin rate failures become `401 Invalid API key` (`web/lib/external-api.ts`; `@better-auth/api-key` 1.7.15 installed `dist/index.mjs` `consumeRateLimit`, `verifyApiKey`). This is a dependency-bound finding, not a live production test. |
| 4 | Same docs: 120 requests per minute; errors guide says wait for next window. | Plugin uses time since **last request**, not a calendar/fixed first-request window. Continued accepted activity extends time until reset; reset needs >60 seconds since last request (`evaluateRateLimit` in that dependency). |
| 5 | Docs broadly describe creator-no-longer-trainer 403. | Only POST users/assignments and PATCH assignments check enabled studio creator. Other operations do not; missing metadata picks oldest enabled trainer (`web/lib/invite/org.ts`; `web/lib/external-api-assignments.ts`). |
| 6 | `docs/errors.mdx`: replace with a current “owner or admin”; Developer page denial copy says only owners/admins manage keys. | Current roles are admin/team/user; enabled team members manage keys too (`web/lib/org.ts`, `web/lib/pages/router.ts` `developer`, `web/app/dash/developer/page.tsx`). |
| 7 | OpenAPI security has only `ApiKeyAuth` (`x-api-key`). | Bearer org keys are accepted too (correctly described in `docs/authentication.mdx`), with header precedence left undocumented (`web/lib/external-api.ts` `externalApiKey`). |
| 8 | `docs/limits.mdx`: another org's resource returns 404. | True for resource detail/ID mutations, not collection filters: foreign user/assignment/scenario IDs yield empty `200` lists. Explicit assignment email overrides userId filter (`web/app/api/v1/assignments/route.ts` GET, `sessions/route.ts` GET). |
| 9 | OpenAPI assignment GET email query has `format: email`. | GET does no email validation, only trims/lowercases; arbitrary strings yield matches/empty list, not 400 (`web/app/api/v1/assignments/route.ts` GET). |
| 10 | OpenAPI `AssignmentTarget.userId` and assignment PATCH `userId` allow empty string; PATCH email has no max length. | Code rejects empty IDs and email >320. POST OpenAPI already caps email at 320. Both schemas omit the trim/lowercase transforms and email/userId precedence (`web/app/api/v1/assignments/*` schemas). |
| 13 | Docs promise idempotent pair creation. | Sequential live POST reuses required member/deployment pair; DB uniqueness prevents duplicates, but concurrent create lacks conflict recovery and can throw (`web/app/api/v1/assignments/route.ts`; `web/prisma/schema.prisma`). |
| 14 | `docs/guides/role-plays.mdx`: “Every response reports emailSent.” | Idempotent assignment POST and no-op PATCH omit it; GET/DELETE responses also do not carry it. Assignment guide and OpenAPI correctly limit its presence to changed/created mutations (`web/app/api/v1/assignments/*`). |
| 15 | OpenAPI `practiceCount` and assignments guide say sessions started / how often learner practised; `lastPracticedAt` is latest practice. | Failed sessions are excluded; soft-deleted sessions are not. Counts can include an earlier recipient/scenario after PATCH. Session list hides soft-deleted records, so list length and count can differ (`web/lib/external-api-assignments.ts` `assignmentDetails`, `web/app/api/v1/sessions/route.ts`). |
| 16 | `docs/guides/role-plays.mdx`: every session has the assignmentId it came from. | Direct/studio sessions can have null, and deleting an assignment sets historical references null. OpenAPI `SessionSummary.assignmentId` correctly permits null (`web/prisma/schema.prisma`, `web/app/api/v1/sessions/*`). |
| 17 | `docs/guides/sessions.mdx` session list example omits assignmentId. | Both list and detail select it on every returned session (`web/app/api/v1/sessions/*`); guide text/OpenAPI otherwise describe it. |
| 18 | Sessions guide / OpenAPI recording URL descriptions: null when no recording exists. | Null also on presign errors; conversely a key/egress ID can yield a signed URL to a missing object because existence is not checked (`web/app/api/v1/sessions/[id]/route.ts`). |
| 19 | `docs/guides/users.mdx`, OpenAPI DELETE user description: learner signed out and cannot sign in. | They retain authentication/sign-in for other enabled orgs; this org is disabled. Only last-enabled-membership disabling deletes auth sessions (`web/lib/members.ts` `setMemberDisabled`, `isDisabledUser`). |
| 20 | Assignment guide / role-plays guide: link keeps working until assignment is removed; OpenAPI describes expired as historical only. | No timestamp expiry is enforced, agreeing with repeat practice. But writers still stamp 30-day expiresAt; cancelled status, changed/reopened share code, disabled access, disabled deployment or insufficient credits can also block the old link before deletion (`web/lib/assignments.ts`, `web/app/api/v1/assignments/*`, `web/lib/pages/learner.ts`, `web/lib/interview-sessions.ts`). |
| 22 | `docs/guides/scenarios.mdx`: pre-existing keys were granted scenarios read by migration. | Migration only modifies keys with an assignments permission entry and no scenarios entry, not all pre-existing keys (`web/prisma/migrations/20260901120000_scenarios_api_permission/migration.sql`). |
| 23 | `docs/errors.mdx`: errors use the standard flat JSON shape, including a 500 table entry. | Resource handlers have no uniform exception catch, and runtime has nested OpenAI errors. Framework 405 is not given this JSON shape either (`web/app/api/v1/*`, `web/lib/runtime/openai.ts`). |
| 24 | Guides describe re-inviting/already-funded recipients as free. | Prior grant means no starting grant/funds check, but email path now directly adds/checks member; userId-only assignment resolution does not give starting credits (`web/lib/org-people.ts`; `web/lib/external-api-assignments.ts`). |

Current assignment guide/OpenAPI match required learner userId/id/name and immediate addition by email; sign-in is Google or an email code, not a password (`docs/guides/assignments.mdx`; `docs/openapi.yaml` `Assignment`, `AssignmentDetail`; `web/lib/external-api-assignments.ts` `assignmentView`, `assignmentDetails`; `web/lib/auth.ts`). Current Users guide/OpenAPI match direct addition, 201/200 user/created/emailSent and always-empty invitations; API role spelling remains member; read-only sessions/scenarios, removed domain fields, ordinary pagination bounds, creator-403 entries on the three mutation operations, credit defaults and sequential reopen behavior otherwise match the handlers. `User.createdAt` is optional in the schema, so its omission from PATCH is not a schema violation (`docs/openapi.yaml`, routes above). `docs/quickstart.mdx`, `docs/README.md`, `docs/docs.json`, `docs/package.json` and `docs/vercel.json` add no further resource-contract discrepancy found in this source audit; no published-site/build assertion is made.

### Postman collection drift

All rows refer to `docs/trainer-twin-api.postman_collection.json` request descriptions, query lists and saved success examples. Generated `<integer>` / `<boolean>` strings are placeholders, not real wire-type examples.

| Collection item | Difference from code / OpenAPI |
| --- | --- |
| List scenarios | Says “most relevant first”; code sorts dashboard `order ASC, createdAt DESC` (`web/app/api/v1/scenarios/route.ts`). |
| Remove a learner | Says membership and assignments are removed. Code disables membership and changes access statuses; account/history stay (`web/app/api/v1/users/[id]/route.ts`, `web/lib/members.ts`). |
| Invite learner examples | Entire pending-invitation response is obsolete; POST returns immediate user/created/emailSent, GET invitations=[] (`web/app/api/v1/users/route.ts`). |
| Update learner example | Includes user `createdAt`, absent from PATCH projection (`web/app/api/v1/users/[id]/route.ts`). |
| List assignments | Query list lacks supported email filter (`web/app/api/v1/assignments/route.ts`). |
| List/get assignment examples | Omit `practiceCount` and `lastPracticedAt`; required-member identity has no nullable pre-join state (`web/lib/external-api-assignments.ts`). |
| Create/change assignment examples | Omit required mutation `assignment.email`; examples show userId only, not an email-only unjoined state (that state no longer exists) (`web/lib/external-api-assignments.ts` `assignmentView`). Bodies showcase only userId/scenario, not supported email. |
| Create existing assignment example | Shows `emailSent`; live-existing code omits it (`web/app/api/v1/assignments/route.ts` POST). |
| List/get session examples | Omit `assignmentId`; get description refers to one recording URL and get example omits `videoUrl` (`web/app/api/v1/sessions/*`). Saved original list requests also omit assignmentId although the main request query includes it. |
| Invite/create/change descriptions and Conflict examples | Do not explain initial 30 credits or insufficient-credit 409. POST assignments description does not explain live return versus cancelled/expired reopening; PATCH does not explain link rotation, no-op omission of emailSent, or duplicate-pair conflict. OpenAPI/guides have these details; implementations are the mutation flows above. |
| Default list-sessions query | Enables placeholder `from=<dateTime>` and `to=<dateTime>`; it returns `400 Invalid session filters` until replaced/disabled. Other enabled user/scenario/assignment placeholders can hide all results (`web/app/api/v1/sessions/route.ts`). |

The collection has the same 15 integrator operations as OpenAPI (no obsolete session POST/DELETE or domain fields); it also omits the separate runtime route. Collection-level `x-api-key:{{apiKey}}` auth and base URL agree with the resource API (`docs/openapi.yaml`, collection `auth`/`variable`, `web/lib/external-api.ts`).

### Product, plans, comments and UI

- `PRODUCT.md` describes the wider trainer/spec/runtime product, not a public API contract; no separate API requirement there overrides these handlers.
- `plans/roleplay-preservation.md` section B still describes email link → “one attempt, 30 days”, public API session start, old `app/dash/agents` paths and no assignment contract tests. Current repeated-link activation, read-only public sessions and `web/tests/api/v1-*.db.test.ts` supersede those parts (`web/lib/interview-sessions.ts`, `web/app/api/v1/sessions/*`). Section A already acknowledges the read-only change.
- `plans/prod-release-v2.md` says `/v1/*` role plays only and labels “v1 API (read-only, role plays only)”; only sessions/scenarios are read-only, users/assignments still mutate, and runtime completions does not filter agent kind. Its member-deletion summary is broader than the pending-only cancellation in `setMemberDisabled`.
- `plans/drop-domains.md` records approved domain removal; current API selections/OpenAPI/Postman have no domain fields. This is an explicit later exception to the frozen-contract language in `plans/roleplay-preservation.md` and `plans/roleplay-skill.md`, not a reason to restore domains.
- UI invalid-link copy says expired/already completed at `web/app/(org)/s/[code]/page.tsx`; current used role-play links remain repeatable and timestamp expiry is ignored (`web/lib/pages/learner.ts`). Developer denial copy has the role mismatch listed above.

- `docs/guides/assignments.mdx` still names the email “New Role Play Assigned”; the current subject is “New role play: <name>” (`web/lib/email.ts` `personEmail`). Its Google/email-code sign-in and required learner identity now match the implementation.

### Open questions

1. Should rate denials be recognized as `RATE_LIMITED`, and is inactivity-based limiting intended? App tests only `RATE_LIMIT_EXCEEDED`; installed plugin emits the other code and uses `lastRequest` reset (`web/lib/external-api.ts`, `web/lib/auth.ts`, installed `@better-auth/api-key/dist/index.mjs`). Production dependency behavior was not exercised in this audit.
2. Should enabled creator checks cover every operation? Only three mutations check it; key verification alone gates reads/DELETE/name PATCH (`web/lib/external-api.ts`; `web/lib/invite/org.ts`; `web/lib/external-api-assignments.ts`).
3. Should contradictory email/userId be rejected instead of email taking precedence? Current learnerFor ignores supplied ID when email exists, returns email account (`web/lib/external-api-assignments.ts`; `docs/openapi.yaml`).
4. Are practice statistics intentionally lifetime-by-assignment-ID, including soft-deleted sessions and pre-move practices? The count query and sessions visibility disagree (`web/lib/external-api-assignments.ts` `assignmentDetails`, `web/app/api/v1/sessions/route.ts`).
5. Should `closing` be a supported public session status? Runtime accepts it; public filter/OpenAPI enum omit it, and returned rows are not status-normalized (`web/lib/interview-sessions.ts` `authorizeRuntimeSession`, `web/app/api/v1/sessions/route.ts`, `docs/openapi.yaml` `SessionStatus`).
6. Should recording evidence keys be checked for org prefix before signing? Detail authorizes the org session but trusts `evidence.videoS3Key`; actual safety depends on its writers. The route has no independent key-scope/existence check (`web/app/api/v1/sessions/[id]/route.ts`, `web/lib/s3.ts`).
7. Should assignment expiry timestamps be retained when no longer enforced, and should moving/deleting preserve a queryable assignment history? Writers still stamp 30 days; moving reuses the ID; deleting nulls references (`web/lib/assignments.ts`, `web/app/api/v1/assignments/[id]/route.ts`, `web/prisma/schema.prisma`).

## [Copilot](copilot.md)

### Mismatches

- Shared normal assignment helpers follow People account/member/assignment ordering except grants commit before missing members; post-grant DB failure can violate the learner-ledger check. Role/disable races and operator bypasses remain in [Organizations and roles — Mismatches](orgs-and-roles.md#mismatches) (`web/lib/org-people.ts:128–159`). Email startup fallback is allowed by People rule 12 and keeps the original event keys (`web/lib/queue-emails.ts` `queueEmails`).

- `PRODUCT.md` describes an evolving blueprint, Agent/Domain YAML drafts, Pipecat/deterministic publishing and recoverable drafts. Today's UI and tools build twin/role-play skill packages; there is no blueprint or draft read/save tool in this copilot (`web/components/copilot-chat.tsx`; `copilot/agent/tools/`; `web/lib/scenario-ingest.ts`).
- `PRODUCT.md` says no unrestricted shell/filesystem access. The app exports Eve's `bash`, `glob`, `grep` and `read_file`; only `write` is path-scoped. Instructions say bash is read-only, but `bash.ts` is an unwrapped tool export, not a read-only command validator (`copilot/agent/tools/bash.ts`, `glob.ts`, `grep.ts`, `read_file.ts`, `write.ts`; `copilot/agent/sandbox.ts`).
- The earlier phase-1 plan names Bearer `COPILOT_SERVICE_SECRET`, `updateAccess` and `shareLink`, with invitation approval. The final plan decisions narrow this to invite-only learners without approval; code follows that narrower scope and uses **`SCENARIO_INGEST_SECRET`** on the internal studio route. `COPILOT_SERVICE_SECRET` remains the web→Eve Basic secret (`plans/copilot-v2.md`; both service routes; `web/lib/copilot-studio.ts`).
- Phase 0 proposes removing `copilot-handoff.ts`; it remains and has current seed consumers/producers, not merely old draft state (`web/lib/copilot-handoff.ts`; `web/components/copilot-chat.tsx`; `web/components/twin/twin-agents-page.tsx`).
- The plan's initial “no upload from composer yet” decision has been overtaken: the current composer uploads temporary images/PDFs. Its Files picker still selects persistent KB items only (`plans/copilot-v2.md`; `web/components/copilot-composer.tsx`; `web/components/copilot-chat.tsx` `send`).
- Phase 2 proposes incremental merge mode for both products. It exists for twin skills; recordings-based role plays load reference files and rebuild instead (`copilot/agent/tools/load_skill.ts`, `build_scenario.ts`; `copilot/agent/lib/twin-skill.ts`).
- The plan proposes soft-deleting knowledge documents and hiding deleted items from the picker. Current copilot queries filter failed status, not a knowledge deleted timestamp (`web/lib/copilot-studio.ts` `listKnowledge`; `web/app/api/internal/knowledge-sources/route.ts`; `web/components/copilot-composer.tsx`). See [Knowledge](knowledge.md) for deletion behavior.

### Open questions

- Should “kept for 30 days” mean erasing extracted text/chunks and already-staged conversation files too? Instructions promise 30-day attachments; `expireUploads` removes objects and clears legacy bytes, but retains extracted text/chunks and does not contact Eve (`copilot/agent/instructions/copilot.md`; `web/lib/uploads.ts`; `copilot/agent/lib/uploads.ts`).
- Should a missing baseline artifact stop an update instead of silently supplying empty items/fallback manifest? `getSkill` tolerates download errors, while `load_skill` treats that answer as the update baseline (`web/lib/copilot-studio.ts` `getSkill`; `copilot/agent/tools/load_skill.ts`).
- Is approval solely at the agent boundary sufficient for all privileged callers? Tools require approval, but the service-secret internal route has no approval proof and ingestion routes require only secret + org, not the enabled acting member check used by studio actions (`copilot/agent/tools/publish.ts`, `update_twin.ts`; `web/app/api/internal/copilot-studio/route.ts`; `web/app/api/internal/scenarios/route.ts`, `twin-skills/route.ts`).

## [Learner portal](learner-portal.md)

### Mismatches

- The comment above loadSharedSession's twin branch still says it creates nothing and assigns at session start, but the branch passes join=true and joins on page opening (`web/lib/pages/learner.ts:95–100` `loadSharedSession`; `web/lib/twin-access.ts` `twinAccessByCode`).

| Stated elsewhere or in copy | Current implementation |
| --- | --- |
| `plans/twin-share-link.md` says readable `/t` joins via an active common share link and uses the same prejoin/session as `/s`. | `/t` is public profile plus assigned-only `TwinLearnerFlow`/`CalibrationCall`; no common-link join or `/s` prejoin. (`web/lib/pages/learner.ts` `loadTwinLink` / `twinAccessFor`; `web/components/twin/twin-learner-flow.tsx`.) |
| `plans/roleplay-preservation.md` A5 describes a role-play-only public catalog; its B table says email invites are one attempt, 30 days. Invalid-link UI says expired/already completed. | Home now shows trainers' main twins and the learner's assigned role plays. `pending`/`used` links allow repeat practice without an `expiresAt` check. (`web/lib/pages/org-home.ts`; `web/lib/pages/learner.ts` `loadSharedSession`; `web/lib/interview-sessions.ts` `activateSession`; `web/app/(org)/s/[code]/page.tsx`.) |
| Twin summary says minutes left **with this twin**. | Minutes are shared by this learner across the org; legacy per-twin limit columns are not used for metering. (`web/lib/pages/learner.ts` `twinAccessFor`; `web/lib/twin-access.ts` `DEFAULT_TWIN_MINUTES`; `web/components/twin/twin-learner-flow.tsx` `Summary`.) |
| `plans/prod-release-v2.md` Roles says learners only practise; `web/lib/auth-roles.ts` says admin/team run the studio. | Portal offers no studio links and twin studio/calibration is guarded. But `web/app/dash/layout.tsx` only requires sign-in; `web/components/app-shell.tsx` has no role gate; `page.talk`, `overview`, `voices`, `settings` and `twinKnowledge` use only `protectedProcedure` in `web/lib/pages/router.ts`. A blanket “learners can never reach any studio page/data” is not enforced by these boundaries. |
| `plans/twin-wiring-and-reliability.md` expects pre-upload/screen-sharing settings to reach learner sessions. | Full settings reach `/s`; `/t` supplies only during-call attachment permission and skips prejoin. (`web/lib/pages/learner.ts`; `web/components/calibration/calibration-call.tsx`.) |
| `PRODUCT.md` focuses on trainer creation and published-spec runtime, not a complete learner portal contract. | These learner pages implement both twin conversations and role-play practice. No additional learner policy is inferred from that creation-workflow description. (`web/lib/pages/org-home.ts`; `web/lib/pages/learner.ts`.) |

### Open questions

1. Should a learner be blocked at the whole dash boundary, rather than only on studio-specific pages/procedures? `web/lib/auth-roles.ts` / `plans/prod-release-v2.md` say learners only practise, but `web/app/dash/layout.tsx` and the protected-only page procedures above permit a broader signed-in surface.
2. Should `/t` honour `preUpload` and `preScreenshare`, or deliberately remain a voice-only immediate start? `plans/twin-wiring-and-reliability.md` expects these settings on learner calls; `web/lib/pages/learner.ts` `twinProfile` and `web/components/calibration/calibration-call.tsx` do not implement that prejoin path.
3. Should the twin profile loader also classify positive balances below 5 minutes as short, rather than allowing ok=true with a disabled button? Its loader threshold is 60 seconds but button and activation require 5 minutes (`web/lib/pages/learner.ts` `twinAccessFor`; `web/components/twin/twin-learner-flow.tsx`; `web/lib/interview-sessions.ts`).
4. Should both end paths preserve the screen on a failed save? `web/components/session-view.tsx` retries before leaving, while `web/components/calibration/calibration-call.tsx` `end` shows a toast and still opens the twin summary.

## [Voice agent and chat](voice-agent-and-chat.md)

### Mismatches

| Intent / older description | Current code |
| --- | --- |
| `PRODUCT.md` says Pipecat and deterministic published-spec execution; root `README.md` describes the web analyze/policy/render path. | Current worker is LiveKit and can use Eve at `LLM_BASE_URL`; Swarm defaults to chat `/v1`. The web runtime remains a selectable backend (`agent/src/agent.py`, `session.py`; `agent/stack.yml`). |
| `plans/chat-twin-roleplay.md` proposes one resolver and hidden per-mode tools, twin-specific finish text, and latest saved ratings in the prompt. | Mode classification exists, but context/skills/tools still make separate memoized requests; many tools remain declared. `finish_session` still says never finish before `session_plan`, conflicting with twin closing instructions. No saved-rating examples are loaded; calibration overlay applies feedback from the current conversation (`session-mode-lookup.ts`; `skills/playbooks.ts`; `tools/finish_session.ts`; `brain.ts`; `prompts/twin.md`). |
| That plan defers client role play to a future branch. | `ROLEPLAY` with a string skill already runs the client prompt and `end_call` (`lib/roleplay.ts`; `tools/end_call.ts`). |
| `plans/twin-content-inventory.md` describes live skills, old coaching-shaped skills and no calibration; `plans/twin-roleplay-db-split.md` initially notes latest-only example items. | Context uses pinned skill lists/versions, twin-creator skills advise on one topic, calibrations have their own overlay, and Chroma stores versioned items with retained-version fallback (`web/lib/session-context.ts`; `chat/agent/lib/brain.ts`; `web/lib/main-collection.ts`). |
| `plans/twin-skill-ingest.md` proposes moving items to a `twin` collection. | Runtime search still uses `MainCollectionService.COLLECTION_NAME="main"` (`web/lib/main-collection.ts`). |
| `agent/.env.example` calls recordings optional and omits `LLM_BASE_URL`/service secret. | Startup requires S3 credentials/bucket and `LLM_BASE_URL`. Speech is VoxCPM2 only. Completion requires the service secret, which startup does not check (`agent/src/agent.py`; `tts/__init__.py`; `recording/webhook.py`). |
| `chat/README.md` describes Bearer-plus-org auth and Python room RPC; bridge comments still describe a request model override. | Bearer is not validated at the completion route; speaker is source-locked; active workspace execution uses studio commands/browser polling with Python `tools=[]` (`openai-compat.ts`; `agent.ts`; `workspace-tools.ts`; `web/lib/livekit-workspaces.tsx`; `agent/src/agent.py`). |
| `plans/twin-wiring-and-reliability.md` originally scopes canonical final transcripts to twins. | Receiver also uses agent transcript readiness for new role plays through `usesAgentTranscript` (`web/app/api/sessions/webhook/route.ts`; `web/lib/session-after.ts`). |

### Open questions

- Is `/v1/chat/completions` protected by an external gateway in deployed chat? Source permits org-header-only access, while `chat/README.md` describes authentication and `lib/auth.ts` requires the shared secret for a Basic principal (`chat/agent/channels/openai-compat.ts`). No external protection is established here.
- Should twin `finish_session` keep interview-only tool instructions? The twin prompt says not to call `session_plan`, while the finish tool says never finish before that plan reports finish (`chat/prompts/twin.md`; `chat/agent/tools/finish_session.ts`).
- How are post-start UI state and attached document lists meant to refresh in the static prompt? Context cache says immutable, yet it reads mutable `runtimeState.uiState` and documents; separate attachment handling does not refresh the entire prompt (`web/lib/session-context.ts`; `chat/agent/instructions/session-spec.ts`; `chat/agent/lib/uploads.ts`).
- Which LiveKit project/credentials does the E2E VM target, and are both registered workers intentionally eligible for the same dispatch? Cloud identity is in `agent/livekit.toml`; VM env is external to `agent/stack.yml`. Shared registration names alone do not establish routing or deployed health.

## [Platform](platform.md)

### Mismatches

- upload-access comments still say a common-code holder joins when the call starts. Actual joining happens on page opening, before normal prejoin uploads. The direct upload fallback is broader than that normal membership-first flow: a signed-in nonmember can upload with an active upload-enabled common code without opening its page or becoming a member; session start still refuses that nonmember (`web/lib/upload-access.ts:7–27` `twinCodeAllowsUpload`, `uploader`; `web/lib/pages/learner.ts` `loadSharedSession`; `web/lib/interview-sessions.ts` `activateSession`). Operator member-read/write bypasses remain in [Organizations and roles — Mismatches](orgs-and-roles.md#mismatches).

- `plans/uploads-to-s3.md` initially proposes purposes `session/calibration/copilot`, `copilotSessionId`, resize-on-read, and soft deletion without S3 deletion. Current code uses `before/during/copilot`, no copilot-session column, upload-time model copies, and hard S3 cleanup on expiry/failure. Its later “As built” section reflects many of these changes (`web/prisma/schema.prisma`, `web/lib/uploads.ts`).
- The upload plan's native copilot PDF decision is superseded by its “As built” note and `pdfAsText` implementation. Copilot gets extracted Markdown; chat gets the PDF link (`plans/uploads-to-s3.md`, `web/lib/copilot-studio.ts`, `web/lib/uploads.ts`).
- Learner report code comments say “for the trainer's team,” but recipients are the fixed TrainerTwin operator addresses, not org team members (`web/components/twin/twin-learner-flow.tsx` `ReportDialog`, `web/lib/issue-alerts.ts`).
- The production release brief labels `web/vercel.json` as region `bom1`; only the root manifest declares that region. Its historical paused-ingestion description must not be read as current pump behavior (`plans/prod-release-v2.md`, both Vercel manifests, `web/lib/ingestion-queue.ts`).
- `docs/README.md` says to deploy by connecting to Mintlify; the repo also has a static-export build and Vercel output/redirect configuration. It does not establish which hosting arrangement is currently active (`docs/package.json`, `docs/vercel.json`).
- `PRODUCT.md` describes an older Pipecat/deterministic architecture and narrow copilot tools without shell/filesystem access. The repo runs a LiveKit voice agent and gives copilot an Eve sandbox. These affect service/deploy understanding; see [Voice agent and chat](voice-agent-and-chat.md) and [Copilot](copilot.md), rather than treating that product text as the platform runtime contract (`ecosystem.config.cjs`, `copilot/agent/sandbox.ts`, `copilot/agent/instructions/copilot.md`).

### Open questions

- **Which Vercel settings are live?** Local studio/chat links name projects, the copilot plan names another, and docs declares a redirect host. The manifests differ on cron coverage and region; the historical release log names branch `v2`. Confirm current project roots, active config, production branches, cron installation, preview secrets and docs hosting in the dashboard (`web/.vercel/project.json`, `chat/.vercel/project.json`, `plans/copilot-v2.md`, `plans/prod-release-v2.md`, root/web/docs `vercel.json`).
- **How do database-less previews pass build validation?** The build comment says previews have no database, while Next config imports an env schema requiring a DB URL unless `SKIP_ENV_VALIDATION` is set. There is no preview-specific exception in that schema (`web/scripts/vercel-build.sh`, `web/next.config.ts`, `web/env.ts`).
- **Should expired content be inaccessible through every reader, and should it be erased?** Resolver checks expiry immediately; view/readDocument require only ready status; raw session reads do not check status/expiry. Cleanup retains extracted text and suppresses S3 deletion errors (`web/lib/uploads.ts`, `web/app/api/uploads/[id]/view/route.ts`, `web/app/api/copilot/studio/route.ts`, `web/app/api/documents/[id]/raw/route.ts`).
- **What guarantees should operators have for alerts and metering?** Reports persist without replay/session columns or an alert outbox, and model usage posts have only bounded in-memory retries. Current behavior is best effort, not exactly-once end-to-end delivery (`web/app/api/issues/route.ts`, `web/prisma/schema.prisma`, `chat/agent/lib/usage.ts`, `copilot/agent/lib/usage.ts`).
