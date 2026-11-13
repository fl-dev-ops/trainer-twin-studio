# Public integration API

> The organization API lets an integration list Studio-authored role plays, add/read learners, read/allocate credits,
> assign practice, and read sessions and results. Role-play authoring and execution are outside this resource API.
> Agreed behavior lives in [API rules](api.md), [People](people.md) and [Practice](practice.md). The published contract
> is `docs/openapi.yaml`; `docs/trainer-twin-api.postman_collection.json` contains matching requests.

## Who uses it

- An enabled org admin/team member creates a key on `/developer`; all default-config keys of that org can be listed
  or revoked by its studio members (`web/app/api/developer/api-keys/route.ts`).
- The integration acts as that key's enabled creator, without a dashboard login (`web/lib/external-api.ts`).
- Learners practise through their personal link in TrainerTwin. They cannot manage integration keys.
- `/api/v1/chat/completions` is a separate session-token model transport, **not** this API-key integration surface
  (`web/lib/runtime/openai.ts`). Its runtime behavior remains in [Voice agent and chat](voice-agent-and-chat.md).

## Data and identities

| Record / term | Meaning |
| --- | --- |
| API key | Better Auth `Apikey`, hashed secret, org in referenceId, creator in metadata.createdByUserId. |
| User / learner | Enabled org member with database role user; public User.role stays member for compatibility. Account id is userId; org membership id is memberId. |
| Scenario | Same-org, unarchived Agent with kind ROLEPLAY. Twins are excluded. Public names/identifiers are retained independently of future runtime redesign. |
| Assignment | RolePlayAssignment for a deployment and member, unique by that pair, with a personal shareCode. |
| Credits | One credit is one minute; the ledger stores integer seconds. Org balance belongs to Meteroid, less pending allocations/usage and active studio reservations. |
| API grant | MinuteLedger type grant with userId and nullable requestKey; unique (orgId,requestKey). Existing non-API rows keep null. |
| Session | One InterviewSession; several sessions may share an assignmentId. Read-only here, including persisted transcript/report/evidence. |

Sources: `web/prisma/schema.prisma`; `web/lib/org-people.ts`; `web/lib/minutes.ts`; `web/lib/org-credits.ts`;
`web/lib/external-api-assignments.ts`. Migration `20261117120000_api_credit_request_key` adds only the nullable request
key and its unique index. It does not change existing grants, balances, users or assignments.

## Authentication and common responses

`requireExternalApi` accepts trimmed `x-api-key`, otherwise a Bearer key. A nonempty x-api-key wins if both are sent.
Better Auth verifies the requested permission before the org and creator are read. The creator must still be enabled
admin/team, checked through orgPeople on every request; no fallback trainer is used. The caller cannot choose an org
by body/query/header (`web/lib/external-api.ts`).

| Resource | Required permissions |
| --- | --- |
| Users | read for GET, write for POST/PATCH/DELETE |
| Credits | Existing users:read for GET, users:write for POST; no new scope or key rotation |
| Scenarios | scenarios:read |
| Assignments | assignments:read/write |
| Sessions | sessions:read; no write handler (old keys may still carry an unused write permission) |

The default key prefix is tt_, length 64, lifetime 365 days. The configured allowance is 120 requests with a 60-second
window. The installed plugin resets after inactivity since lastRequest, not a strict wall-clock bucket. Verification
consumes usage before resource validation; a subsequent invalid-input response can still count. Rate refusals include
Retry-After in seconds (ceil(plugin milliseconds), minimum 1, fallback 60). No remaining/reset headers are added.
Sources: `web/lib/auth.ts`, installed `@better-auth/api-key`, `web/lib/external-api.ts`.

Every resource method uses apiRoute(handleX): AppErrors retain `{error,code}` and status; unexpected errors are logged
and return internal_error/500. Missing/invalid keys are api_key_invalid/401, missing permissions scope_missing/403,
and a missing/disabled/nonstudio creator api_key_owner_gone/403. Refer to [API refusals](api.md#refusals).

Bodies are strict objects. Pagination is limit 1–100 (default 50), offset 0–2147483647 (default 0), decimal digits only;
blank, fractional, exponent/hex and unsafe integers are invalid_input/400. Lists return pagination.total. Unknown
query parameters remain ignored. Users are paged in memory (the existing few-thousand-person limitation); scenarios,
assignments and sessions use database skip/take with deterministic timestamp/ID ordering.

## Resource endpoints

All paths below are relative to `/api/v1`.

| Endpoint | Current implementation |
| --- | --- |
| GET /scenarios | Unarchived org ROLEPLAY rows; order ASC, createdAt DESC, id DESC. Summary: slug, name, version, visibility, order, assignmentCount, timestamps. Private role plays are included. |
| GET /scenarios/{slug} | Same visibility; adds opaque data for compatibility, not a stable runtime configuration contract. |
| GET /users | Enabled learners only, newest membership first; optional exact case-insensitive email filter. Returns users, invitations:[], pagination. User includes creditsGiven/creditsLeft. |
| POST /users | Strict email. Add learner/account through addPeopleToOrg, once-only 30 starting credits. 201 new, 200 existing; user, created, emailSent. Disabled/studio recipient refuses. |
| GET /users/{id} | Same learner visibility and credit fields; membership createdAt, not account creation time. Foreign/disabled/studio/unknown is not_found/404. |
| PATCH /users/{id} | Name only, trimmed 1–100 chars. Same name is a no-op. Other-org membership (disabled included) blocks a changed name with account_shared/409. No createdAt/credit counters in this mutation response. |
| DELETE /users/{id} | Disable, sign out where applicable, cancel links/end live calls, retain history. Already disabled still invokes cleanup and returns 204. A committed disable whose call cleanup fails can return calls_not_ended/500. |
| GET /credits | Available balanceMinutes, defaultLearnerMinutes (30), maxLearnerMinutes (360); no Meteroid identifiers. Refresh with cached fallback. |
| GET /users/{id}/credits | userId, givenMinutes, usedMinutes, balanceMinutes, maxLearnerMinutes. Fractional usage is retained; displayed availability clamps at zero. |
| POST /users/{id}/credits | Whole minutes 1–360, optional trimmed note ≤200, required Idempotency-Key. See retry behavior below. |
| GET /assignments | Org assignments, all statuses; userId OR email filter, optional scenario, pagination. Invalid email or both recipient filters is invalid_input/400. Foreign/unknown/disabled recipient filters match nothing. |
| POST /assignments | Scenario plus email OR userId. Email may add a learner with starting credits; userId must already be an eligible learner. Open pair returns 200 unchanged; new/reopened pair is 201. |
| GET /assignments/{id} | user, scenario metadata, practiceUrl, status, assignedAt, practiceCount and lastPracticedAt. Archived/cancelled history remains readable. |
| PATCH /assignments/{id} | Change recipient or scenario, never both email and userId. Locked source/target decision; unchanged and move retries return changed:false, no second email. |
| DELETE /assignments/{id} | Under minutes/people locks, delete only pending/no-sessions. Otherwise/repeated delete is not_found/404. No credit refund or email. |
| GET /sessions | Org ROLEPLAY calls, including trainer calls and disabled learners' history; deleted/twin calls excluded. Filter status, userId, scenario, assignmentId, from/to. Dates use startedAt, require from≤to, and omit unstarted calls. Includes closing status and chargesOrg. |
| GET /sessions/{id} | Summary plus stored transcript, report/reportStatus, evidence and signed audio/video URLs. No generation is triggered. Unknown/foreign/deleted/twin is not_found/404. |

Route sources are `web/app/api/v1/<resource>/route.ts` and `<resource>/[id]/route.ts`; public scenario detail uses
`scenarios/[slug]`. Credit handlers use `web/lib/external-api-credits.ts`, assignments use
`web/lib/external-api-assignments.ts`, and all membership reads go through `web/lib/org-people.ts`.

## Credit grants and retries

The request key is trimmed, 1–128 non-whitespace characters, scoped to the org rather than one API key. API input never
chooses an org. `grantMinutes` refreshes the remote balance before acquiring minutes:<org> then people:<org>. Inside
those locks it validates userId/email membership, disabled/learner role, and checks the prior request row. Reusing the
key with a different user, email, amount or normalized note is idempotency_conflict/409. Matching replays write nothing
and bypass new-grant pause/cap/balance refusal; learner eligibility and key authorization still apply.

A new grant checks pause, spendable balance and MAX_LEARNER_MINUTES (360 total allocated, net of historical reclaims).
Spending does not reopen that cap. The ledger row and request key commit together. After commit, usage reporting runs
for a new grant or an unsent replay; Meteroid uses the ledger id as event id. No request can mint org credits.

The response contains the immutable grant id/userId/minutes/note/createdAt, created (201 true, 200 false), current
learner balanceMinutes, current orgBalanceMinutes and emailSent. Balance fields may change between retries. The
receipt is read by its unique org/request key; there is no public grant deletion operation.

New grants attempt the usual person/credits email with `credits:<ledgerId>` after commit. Failures return emailSent=false
without undoing credits. Replays do not send again. This is durable **allocation** idempotency, not a durable email
outbox: interruption between commit and notification can leave an email unsent. In development the sender intentionally
skips delivery. Sources: `web/lib/minutes.ts` grantMinutes; `web/lib/external-api-credits.ts`; `web/lib/queue-emails.ts`.

## Assignment mutations and history

POST/PATCH and filters reject simultaneous email and userId, including when they refer to the same account.
`assignScenario` uses addPeopleToOrg's minutes/people transaction for email and takes those same locks for userId.
It checks the target deployment belongs to an unarchived role play in the org. Disabled/studio recipients refuse;
unknown userId returns not_found. Any source status and open target are reread under the locks:

- Open same pair: unchanged.
- Open source, another open target: assignment_exists/409.
- Closed source, requested open target: unchanged replay.
- Closed source, no open target: roleplay_access_removed/403.
- Otherwise create/reopen target and cancel source, returning the selected row from inside the transaction.

The source is not repointed: its calls retain their identity. A previously closed target pair reopens the **same** id
with a fresh code and retains its own earlier calls; this existing history model was not redesigned. Repeated POST of
an open pair sends no extra email. The API move itself does not end an already-live call; runtime behavior remains in
[Sessions](sessions.md).

API and dashboard deletion share removeRoleplayAssignment. It holds minutes:<org> (also held by Start) then people:<org>,
and performs deleteMany with pending and no sessions predicates. The FK's onDelete:SetNull cannot detach a session
created by a concurrently locked Start. Other nonconforming direct database writers are not covered by advisory locks.
Sources: `web/lib/roleplay-access.ts`; API assignment routes; `web/app/api/role-play/[slug]/assignments/route.ts`.

Practice counts include started, non-failed sessions for that assignment, including active/abandoned and currently
soft-deleted sessions; session list reads separately exclude deleted rows. Links remain pending after practice; legacy
used stays open. Stored expiresAt is not enforced by current runtime, as documented in [Role plays](roleplays.md).

## Session results and recordings

Session reads do not require the learner to remain enabled or the agent to remain unarchived. Filtering a foreign or
unknown user/scenario/assignment id yields an empty list, not a detail 404. Transcript, report and evidence are stored
JSON; the API does not promise the underlying runtime's internal structure or alter report selection/scoring.
Report status may be none/generating/completed/failed/null. chargesOrg identifies billed trainer calls, not all trainer
calls: free studio calls also have false.

Recording keys must belong to the session org (orgOwnKey). Links last one hour; signing failure yields null for that
recording. Object existence is not checked. A video with an egress id can use its standard org-scoped fallback key.
Internal s3AudioKey/videoEgressId are removed from the response, but existing evidence is retained for compatibility.
Sources: `web/app/api/v1/sessions/[id]/route.ts`, `web/lib/s3.ts`.

## Remaining limits and mismatches

- **API 1, key management:** the studio's 20-key count/create is still not serialized. Concurrent key creations from
  19 can exceed 20 (`web/app/api/developer/api-keys/route.ts`). No scope picker/expiry editor is exposed.
- **API 5, account rename:** checking other-org memberships and updating User.name are not atomic with a new membership
  created elsewhere (`web/app/api/v1/users/[id]/route.ts`, `web/lib/org-people.ts` inOtherOrgs). This pass does not change it.
- **Notifications:** API add/assignment/credit state may commit before notification. Email startup/provider retries
  do not constitute a durable outbox; replay does not recover an unsent post-commit email. Credit grants remain deduplicated.
- **Runtime races remain separate:** full access rechecks on resume, simultaneous first starts, archive/save ordering,
  and report-kind snapshot consistency are not changed here. See [Role plays](roleplays.md) and [Sessions](sessions.md).
- **Mutable catalog:** a role play can be archived after a lookup. Authoring/archive writers do not all share the
  integration mutation locks. This API rechecks the target in its transaction but does not freeze catalog lifetime.
- **Public input compatibility:** User.role stays member; userId is opaque; user PATCH does not return list-only fields.
  Invalid/unknown query parameter names are not globally rejected. User pagination still loads the org's learner list.
- **Developer error vocabulary:** non-v1 key-management validation/missing-key errors remain uncoded. The separate model
  transport retains its own errors/authentication. Neither is silently described as a resource API fix.
- **Deferred product/security work:** End semantics #21; copilot service authority/invite approval #22; no integration
  completion webhooks, runtime start APIs, bulk operations or org-credit purchases were added.

## Tests and release boundary

- `web/tests/api/v1-credits.db.test.ts`: real API keys, complete catalog→learner→grant→assignment→session/read flow,
  grant replay/conflict/parallel spending, scopes, disabled/foreign/studio users, reservations, cap and notification failure.
- `web/tests/lib/roleplay-assignments.db.test.ts`: same/different-target overlapping moves, recipient ambiguity,
  no-op validation and existing assignment contracts.
- `web/tests/api/module6-contract.db.test.ts`: deletion waiting for uncommitted session creation under Start's lock.
- `web/tests/api/integration-contract.test.ts`: OpenAPI/resource method coverage, shared error declarations,
  idempotency schema and Postman request coverage.
- Existing API, people, credit and workflow suites remain regression coverage. External services are mocked in these
  tests; their results do not prove live delivery, production migration safety or deployed runtime behavior.

The request-key migration is additive and must precede the new web code. No production migration/deployment is part of
this implementation pass; release gates from the hardening review remain outstanding.
