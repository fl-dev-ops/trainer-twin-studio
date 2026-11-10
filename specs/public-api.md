# Public API

> TrainerTwin's organization API lets a server invite and manage learners, read role-play scenarios, assign them, and read practice results. An organization API key chooses the organization and permissions. Practice itself starts in the app, not through these resource endpoints. One route under the same `/api/v1` prefix, `/chat/completions`, is a separate session-token runtime interface, not the integrator API. This spec describes the implementation and records differences from the published `docs/` contract.

## Who uses it

| Who | What they can do | Source |
| --- | --- | --- |
| Enabled organization admin or team member (a **trainer**) | Create, list and revoke any default-config API key of their current organization, not just their own. | `web/lib/org.ts` `getTrainerOrg`, `web/app/api/developer/api-keys/route.ts`, `web/lib/pages/router.ts` `developer` |
| Learner (`member.role = user`) | Cannot manage keys. Uses the assignment link to practise in the app. | `web/lib/org.ts`, `web/lib/pages/router.ts` `developer`, `web/lib/pages/learner.ts` `loadSharedSession` |
| API integrator | Uses a key to act on its organization's learners, assignments, scenarios and role-play sessions. No dashboard login is required for these requests. | `web/lib/external-api.ts` `requireExternalApi`, `web/app/api/v1/*/route.ts` |
| Key creator | Supplies the trainer identity for invitations and assignment POST/PATCH. These operations check that the creator still has an admin/team membership. Other resource operations do not make that check. | `web/lib/invite/org.ts` `inviteLearnerByApi`, `web/lib/external-api-assignments.ts` `findKeyTrainer`, `web/lib/external-api.ts` |
| Voice/runtime client | Sends a session runtime token to `/api/v1/chat/completions`; an organization API key does not authorize it. | `web/lib/runtime/openai.ts` `handleCompletions`, `web/lib/interview-sessions.ts` `authorizeRuntimeSession` |

## Words used here

| Term | Meaning / code name |
| --- | --- |
| Organization / org | Tenant selected from the verified key's `referenceId`, not from the caller's body, query or host (`web/lib/external-api.ts`). |
| API key | Server secret with `tt_` prefix; the `Apikey` record stores its hash, permissions and organization reference (`web/lib/auth.ts`, `web/prisma/schema.prisma` `Apikey`). |
| Scope / permission | A resource/action pair, such as `assignments:write`, passed to Better Auth's verifier (`web/lib/external-api.ts` `ExternalApiResource`, `ExternalApiAction`). |
| Trainer | An `admin` or `team` organization member (`web/lib/org.ts` `STUDIO_ROLES`). |
| Learner / API user | An enabled organization member with database role `user`. API responses call that role `member`; a user ID identifies the account, while `memberId` identifies its organization membership (`web/lib/external-api.ts` `API_LEARNER_ROLE`, `findOrgLearner`). |
| Scenario | An organization `Agent` with `kind = ROLEPLAY` and `archivedAt = null`; the routes call this published. Twins are excluded (`web/lib/external-api-assignments.ts` `findScenario`). |
| Deployment | The organization's delivery record for one agent. Assignment uniqueness checks use its ID (`web/lib/deployments.ts` `ensureDeployment`). |
| Assignment | A `RolePlayAssignment` linking a recipient email to a deployment, with a personal share code (`web/prisma/schema.prisma`). |
| Practice URL | `https://<org.slug>.<BASE_DOMAIN>/s/<shareCode>` (`web/lib/external-api-assignments.ts` `practiceUrl`). |
| Session / practice | One call; repeated practices can share an `assignmentId` (`web/lib/interview-sessions.ts` `activateSession`). |
| Credit / minute | One minute of learner practice, represented by seconds in the ledger. Initial API grants are 30 credits; see [Credits](credits.md) (`web/lib/minutes-config.ts`, `web/lib/minutes.ts`). |
| Runtime token | A session-scoped secret matched by its hash, separate from `Apikey` (`web/lib/interview-sessions.ts` `authorizeRuntimeSession`). |

## Data

The API layer owns the key-management boundary, not separate copies of learners, scenarios or sessions.

| Record | Relevant fields and writers | Source |
| --- | --- | --- |
| `Apikey` (`apikey` table) | `id`, `configId` (default `default`), `name`, `start` (display prefix), `prefix`, `key` (hash), `referenceId` (org ID), `enabled`, `expiresAt`, `permissions` and `metadata` (serialized). Metadata records `createdByUserId`. Better Auth creates/verifies/updates usage; Developer DELETE removes the row. | `web/prisma/schema.prisma` `Apikey`, `web/lib/auth.ts`, `web/app/api/developer/api-keys/route.ts` |
| Key usage fields | `rateLimitEnabled`, `rateLimitTimeWindow`, `rateLimitMax`, `requestCount`, `lastRequest`; optional quota/refill fields `remaining`, `refillAmount`, `refillInterval`, `lastRefillAt`; `createdAt`, `updatedAt`. Developer UI does not expose editing them. | Same schema and routes; `web/components/api-key-manager.tsx` |
| `Invitation` / `Member` / `User` | POST users creates or refreshes an invitation, not an account. PATCH users writes the shared account's `name`. DELETE disables the membership. See [Invites and emails](invites-and-emails.md), [Organizations and roles](orgs-and-roles.md). | `web/lib/invite/org.ts`, `web/app/api/v1/users/[id]/route.ts`, `web/lib/members.ts` |
| `RolePlayAssignment` | `orgId`, `deploymentId`, `recipientEmail`, `assignedByUserId`, nullable `memberId`, unique `shareCode`, `status`, `assignedAt`, `expiresAt`, nullable `usedAt`; default `mode = voice`. POST creates/reopens; PATCH resets a changed assignment; DELETE physically deletes it. | `web/prisma/schema.prisma`, `web/app/api/v1/assignments/route.ts`, `web/app/api/v1/assignments/[id]/route.ts` |
| `InterviewSession.assignmentId` | Nullable reference to the assignment; `onDelete: SetNull`. Deleting an assignment retains sessions but loses their assignment association. Session metadata/results are read here; see [Sessions](sessions.md). | `web/prisma/schema.prisma` `InterviewSession`, `web/app/api/v1/sessions/*` |
| `MinuteLedger` | Initial grants belong to normalized email + org, not to an assignment. The grant is committed before the invitation/assignment is saved. See [Credits](credits.md). | `web/lib/minutes.ts` `giveStartingMinutes`, `web/lib/invite/org.ts`, assignment POST/PATCH |

Lifecycles:

- Key: created enabled → expires after 365 days, or row deleted on revocation. There is no renewal/expiry-edit route in the Developer API; rotate by creating another key (`web/lib/auth.ts`, `web/app/api/developer/api-keys/route.ts`).
- Invitation: new pending → refreshed pending with expiry 48 hours from now; acceptance is owned by [Invites and emails](invites-and-emails.md) (`web/lib/invite/org.ts` `inviteLearnerByApi`).
- Assignment: new pending → used on session creation; pending/used POST is a no-op; cancelled/expired POST reopens the same ID as pending; a changed PATCH resets any status to pending; DELETE removes the row. Failed first activation can restore used → pending. See [Role plays](roleplays.md) (`web/app/api/v1/assignments/*`, `web/lib/interview-sessions.ts` `activateSession`, `web/lib/session-activation.ts`).
- Assignment writers still store `expiresAt = now + 30 days`, but current link opening/activation does not test that timestamp. A stored status of `expired` is different: it is not accepted for practice (`web/lib/assignments.ts` `assignmentExpiresAt`, `web/lib/pages/learner.ts` `loadSharedSession`, `web/lib/interview-sessions.ts` `activateSession`).

## How it works

### Create and use a key

1. Open `/developer` on the dashboard (source `web/app/dash/developer/page.tsx`; dashboard path rewriting is in `web/proxy.ts`). `page.developer` checks `isStudioRole` and lists current-org `configId = default` keys, newest first. It returns only display fields, never the hash or secret (`web/lib/pages/router.ts` `developer`).
2. Enter a trimmed name of 1–60 characters. The manager POSTs `{name}` to `/api/developer/api-keys`. The route requires `getTrainerOrg`, records the org and creator, then calls `auth.api.createApiKey`. It returns `201 {key, record}`; `record` contains `id,name,start,enabled,expiresAt,lastRequest,createdAt`. The full secret lives in component state and is shown/copyable after creation; it is not returned by key lists (`web/components/api-key-manager.tsx`, `web/app/api/developer/api-keys/route.ts`).
3. Better Auth generates a `tt_` key with configured key length 64, hashes it by default, sets expiry to 365 days and defaults permissions as below. There is no scope picker, custom expiry or per-key limit editor in this UI/route (`web/lib/auth.ts` API-key plugin; dependency `@better-auth/api-key` 1.7.15 `createApiKey`, `defaultKeyHasher`).
4. Send a nonempty trimmed `x-api-key`, or `Authorization: Bearer <key>` (case-insensitive scheme). A nonempty `x-api-key` wins even if a valid bearer key is also present. `requireExternalApi` asks Better Auth to verify the exact resource/action and loads the organization by key `referenceId` (`web/lib/external-api.ts` `externalApiKey`, `requireExternalApi`).
5. Revoke through the manager's confirmation and DELETE `{id}`. It deletes only a current-org default-config row; success is `204`, missing/foreign key is `404`. All trainers can revoke another trainer's key in the same org. The next verification cannot find it (`web/app/api/developer/api-keys/route.ts`, `web/components/api-key-manager.tsx`).

Default scopes and actual use (`web/lib/auth.ts`, every resource handler in `web/app/api/v1/`):

| Resource | Granted on creation | Used by routes |
| --- | --- | --- |
| `users` | `read`, `write` | GET requires read; POST/PATCH/DELETE require write. |
| `assignments` | `read`, `write` | GET requires read; POST/PATCH/DELETE require write. |
| `sessions` | `read`, `write` | Only read is used. No session create/update/delete handler exists here. |
| `scenarios` | `read` | Read only. |

Old keys with an `assignments` permission entry but no `scenarios` entry receive `scenarios:[read]` in migration `web/prisma/migrations/20260901120000_scenarios_api_permission/migration.sql`. It does not update every old key.

### Invite or assign with starting credits

- **POST users:** validate email → reject any existing org membership (disabled membership has its own `409`) → find creator's trainer membership → give starting credits → refresh the first pending invitation for that org/email or create one → send invitation email → return `201` new or `200` refreshed with `emailSent`. Refresh sets inviter and 48-hour expiry but does not change an existing invitation's role. See [Invites and emails](invites-and-emails.md) for the org-home link and acceptance (`web/lib/invite/org.ts` `inviteLearnerByApi`).
- **POST assignments:** validate target → look up supplied learner ID, nonarchived role play, creator's trainer membership → choose email → ensure deployment → find an assignment for deployment/email. Pending or used returns `200`, same ID/code/time, `created:false`, no grant or email. Otherwise give initial credits, create or reopen with fresh code/time/expiry and pending status, then email; return `201`, `created:true` (`web/app/api/v1/assignments/route.ts` POST).
- **PATCH assignments:** load current org assignment → resolve target learner/scenario/trainer → ensure deployment. Same email and deployment returns `changed:false` without grant, reset or email, even if cancelled/expired. A conflicting deployment/email pair (any status) returns `409`. Otherwise give initial credits, reset assignment binding/status/code/timestamps, save and email. Old code no longer resolves (`web/app/api/v1/assignments/[id]/route.ts` PATCH).
- `giveStartingMinutes` normalizes email and gives 30 only if no prior `grant` row exists for that org/email, even if previous credits are exhausted or taken back. It checks fresh Meteroid org credits minus pending spending under an org transaction lock (`web/lib/org-credits.ts`). A short balance returns a `MinutesError`; all three API flows translate it to `409` before writing an invitation/assignment or sending mail. Assignment POST may already have created a deployment. No new grants means no balance check, including for an unbilled org. No-op assignment POST/PATCH bypass it (`web/lib/minutes.ts` `giveStartingMinutes`, `web/lib/minutes-config.ts`, the three callers).
- Public REST emails are sent immediately through `deliverInviteEmail` (`web/lib/schedule-invite-emails.ts`). A false result starts `sendInviteEmails([email])` for background retries without changing the response shape: `emailSent` is still the immediate send result, not final delivery. Assignment keys are `assignment:${id}:${shareCode}`; learner invitation keys are `invitation:${invitation.id}:${expiresAt ms}`. The workflow reuses that key; enqueue failure logs and leaves saved access intact. Password/team invitation and operator sends are separate.
- Initial credit grants and the invitation/assignment write are not one transaction: later persistence failures do not roll back the grant. Reported email delivery failure leaves saved state intact. Assignment email uses current learner balance, floored to nonnegative whole minutes, plus objective and required artifact information. See [Credits](credits.md) and [Invites and emails](invites-and-emails.md) (`web/lib/external-api-assignments.ts` `emailAssignment`, `web/lib/invite/org.ts`).
- PATCH users changes only a name and has no credits effect. No public resource route accepts a custom grant amount, top-up or balance adjustment (`web/app/api/v1/users/[id]/route.ts`, assignment schemas).

### Repeat practice and results

The returned practice link hands off to [Learner portal](learner-portal.md) and [Sessions](sessions.md). Opening it checks org, pending/used status, recipient identity and available minutes. First activation joins a new learner to the org. A later practice creates a new session with the same `assignmentId`; an activating/active call on the same assignment/user is resumed instead. The web session route, not POST `/api/v1/sessions`, starts practice (`web/lib/pages/learner.ts` `loadSharedSession`, `web/lib/interview-sessions.ts` `activateSession`, `web/app/api/sessions/route.ts`).

`assignmentDetails` reports `practiceCount` as the number of sessions with that `assignmentId`, nonnull `startedAt` and status other than `failed`; `lastPracticedAt` is the maximum qualifying start or null. Active/abandoned sessions count. There is no `deletedAt` filter here, unlike the sessions list. A moved/reopened assignment keeps its ID, so counts can include practices by its previous recipient/scenario. GET `/sessions?assignmentId=…` applies ordinary session visibility filters and includes sessions without a start unless additional filters exclude them (`web/lib/external-api-assignments.ts` `assignmentDetails`, `web/app/api/v1/sessions/route.ts`).

## Rules

1. All resource handlers authenticate before validation or lookup. Only the runtime completions route uses different authentication. Missing/invalid keys cannot inspect resources (`web/app/api/v1/*/route.ts`, `web/lib/external-api.ts`).
2. Each resource operation requires its listed scope. Missing scope is returned as `401 Invalid API key`, not `403` (`web/lib/external-api.ts` `requireExternalApi`; dependency `validateApiKey`).
3. Org comes only from key `referenceId`. Detail/mutation lookups constrain org; an out-of-org user, assignment, scenario or session ID answers like an unknown one. Assignment email targets need not have joined this or any org (`web/lib/external-api.ts` `findOrgLearner`, all resource route `where` clauses).
4. Users list/detail/update/delete operate only on enabled role `user` memberships. API role output is always `member`, never the database spelling. The list's `createdAt` is membership creation, not account creation (`web/app/api/v1/users/route.ts`, `web/app/api/v1/users/[id]/route.ts`).
5. Creator checks exist only in POST users, POST assignments and PATCH assignments. They require admin/team role, but do **not** filter `disabledAt`. Missing creator metadata falls back to any org trainer rather than refusing the key (`web/lib/invite/org.ts` `inviteLearnerByApi`, `web/lib/external-api-assignments.ts` `findKeyTrainer`).
6. Resource mutation bodies are strict objects: unknown fields, malformed JSON and wrong field types fail `400`. Email/name are trimmed; emails are lowercased before lookup/write. Assignment `userId` is nonempty but not trimmed, and scenario must match `^[a-z0-9][a-z0-9._-]*$` case-insensitively (`web/app/api/v1/users/*`, `web/app/api/v1/assignments/*`).
7. Assignment POST requires scenario and at least one of email/userId. PATCH requires at least one of email/userId/scenario. Both may accept email and userId together: the ID must resolve to an enabled org learner, but explicit email wins as recipient; returned `userId` may therefore describe a different account (`web/app/api/v1/assignments/route.ts` POST, `[id]/route.ts` PATCH).
8. Collection pagination is `limit=50`, `offset=0` by default; supplied values must coerce with JavaScript `Number` to integer limit 1–100 and offset ≥0 or return `400 Invalid pagination`. Empty offset becomes 0, empty limit fails; exponent/hex forms can pass. Unknown query parameters are ignored; strict session validation receives only named extracted fields (`web/lib/external-api.ts` `paginationFromUrl`, collection GET handlers).
9. The configured per-key rate allowance is 120 verifications with a 60,000 ms inactivity reset: the installed plugin resets when time since `lastRequest` is **greater than** the window, otherwise increments until the cap. Accepted verification happens before resource validation, so a later resource `400` still consumes usage. There are no rate-limit or retry headers in this wrapper (`web/lib/auth.ts`, `web/lib/external-api.ts`; installed `@better-auth/api-key/dist/index.mjs` `evaluateRateLimit`, `consumeRateLimit`). See the error-code mismatch below: actual rate denial currently becomes `401`.
10. POST assignment idempotency is an application lookup on deployment/email, not an idempotency-key header or database uniqueness constraint on that pair. Repeated live POST does not resend; changed PATCH does resend. Sequential repeat behavior is guaranteed by the branch, not by an atomic upsert (`web/app/api/v1/assignments/route.ts`, `web/prisma/schema.prisma` `RolePlayAssignment`).
11. DELETE users disables, not deletes: cancels pending role-play assignments, revokes active twin assignments/assigned sessions, closes active/activating calls, and retains account/history/credits. Authentication sessions are deleted only when no other enabled membership exists. Used role-play assignments are not cancelled by this helper. See [Organizations and roles](orgs-and-roles.md) (`web/lib/members.ts` `setMemberDisabled`).
12. Scenario read/assignment target lookup excludes twins and archived agents but does not check visibility or draft/version metadata beyond the agent row. Existing assignment GET/PATCH-without-scenario can still reference an archived role play (`web/lib/external-api-assignments.ts`, `web/app/api/v1/scenarios/*`, `web/app/api/v1/assignments/[id]/route.ts`).
13. Sessions GET returns only same-org, non-deleted sessions whose agent is `ROLEPLAY`. It does not require the user to remain an enabled learner or the agent to remain unarchived. User/scenario/assignment filters are equality filters, not existence checks; unknown/foreign IDs normally yield an empty `200` list (`web/app/api/v1/sessions/route.ts`, `[id]/route.ts`).
14. Only known errors explicitly handled by each route have the flat JSON error contract. Unexpected exceptions in resource handlers propagate to Next; no shared flat-JSON `500` handler is installed here (`web/lib/external-api.ts`, resource handlers). Runtime completions has its own structured error catch (`web/lib/runtime/openai.ts` `handleCompletions`).

## Entry points

### Shared resource responses and errors

All paths below are under `/api/v1`. A date selected as a `Date` serializes as an ISO timestamp. Successful collection responses include `{pagination:{limit,offset,total}}`. In all resource rows, add these shared errors (`web/lib/external-api.ts` `requireExternalApi`):

| Status | Exact `error` string / condition |
| --- | --- |
| `401` | `Missing API key`; `Invalid API key` for failed verification, including missing permission; `API key organization not found` for missing org. |
| `429` | `API rate limit exceeded` **only** when verifier code equals `RATE_LIMIT_EXCEEDED`. Installed plugin uses `RATE_LIMITED`, which instead follows the `401` branch. |
| `400` | `Invalid pagination` on any collection with invalid limit/offset. |

Resource errors below are JSON `{error: string}`. Successful DELETE has no body. Omitted methods are not implemented (Next returns `405` for unsupported methods, including POST `/sessions` and DELETE `/sessions/{id}`; see `web/tests/api/v1-roleplay-only.test.ts`).

### Users

Source for collection rows: `web/app/api/v1/users/route.ts`; detail rows: `web/app/api/v1/users/[id]/route.ts`; invitation errors: `web/lib/invite/org.ts` `inviteLearnerByApi`.

| Method + path; scope | Input / validation | Success | Other handled errors / isolation |
| --- | --- | --- | --- |
| GET `/users`; `users:read` | Pagination only. | `200 {users,invitations,pagination}`. Users: `id,name,email,emailVerified,createdAt,role,memberId`, newest membership first. Invitations: every same-org pending learner invitation, newest first, `id,email,status,expiresAt,createdAt`, unpaginated and not filtered by expiry. `total` counts enabled learners only. | Org + enabled learner filters; no trainer accounts in users or trainer invitations in invitations. |
| POST `/users`; `users:write` | Strict `{email}`; trimmed valid email, max 320. | `201` new / `200` refreshed `{invitation:{id,email,status,expiresAt},emailSent}`. | `400 A valid email is required`; `409 User is already an organization member`; `409 User was removed (disabled); re-enable them in Settings → Team and users`; `403 API key creator is no longer an organization trainer`; credit error text with `409`. Membership/invite lookups use org. |
| GET `/users/{id}`; `users:read` | Opaque account ID; no extra path schema. | `200 {user}` with same fields as list, including membership `createdAt`. | `404 User not found` if unknown, foreign, trainer or disabled. |
| PATCH `/users/{id}`; `users:write` | Strict `{name}`; trimmed length 1–100. Validation precedes member lookup. | `200 {user:{id,name,email,emailVerified,memberId,role}}`; **no `createdAt`**. | `400 A name of up to 100 characters is required`; `404 User not found` with same visibility as GET. Scoped member lookup precedes a global `User` name update. |
| DELETE `/users/{id}`; `users:write` | Opaque account ID. | `204` after `setMemberDisabled`. | `404 User not found`; repeat DELETE also `404` because disabled members are hidden. Helper exceptions are not translated here. |

### Scenarios

Source: `web/app/api/v1/scenarios/route.ts`, `web/app/api/v1/scenarios/[slug]/route.ts`.

| Method + path; scope | Input / validation | Success | Other handled errors / isolation |
| --- | --- | --- | --- |
| GET `/scenarios`; `scenarios:read` | Pagination only. | `200 {scenarios,pagination}`. Each: `slug,name,version,visibility,order,createdAt,updatedAt,assignmentCount`. Order: `order ASC`, then `createdAt DESC`. Count is pending/used assignments of `deployments[0]`, or 0. | Same org, `ROLEPLAY`, unarchived; private scenarios are included. |
| GET `/scenarios/{slug}`; `scenarios:read` | Raw slug path; no regex validator on this GET. | `200 {scenario}`: list fields plus raw `data`. | `404 Scenario not found`, also for foreign, twin or archived agent. |

### Assignments

Source: `web/app/api/v1/assignments/route.ts`, `web/app/api/v1/assignments/[id]/route.ts`, `web/lib/external-api-assignments.ts`.

`Assignment` mutation view is `{id,assignedAt,userId,email,scenario}` (scenario slug). `AssignmentDetail` is `{id,assignedAt,status,practiceCount,lastPracticedAt,user,scenario,practiceUrl}`. Its `user` is the bound member's `{id,name,email}`, else the enabled org learner matching recipient email, else `{id:null,name:null,email:recipientEmail}`. Its `scenario` is the deployment agent's current `{slug,name,version,visibility}`, not session-pinned configuration (`assignmentView`, `assignmentDetails`, `assignmentDetailSelect`).

| Method + path; scope | Input / validation | Success | Other handled errors / isolation |
| --- | --- | --- | --- |
| GET `/assignments`; `assignments:read` | Pagination; optional `userId`, trimmed/lowercased `email`, `scenario`. Empty filters ignored; no email/slug format validation. Email takes precedence over the email resolved by userId; userId-only unknown/foreign/disabled learner uses empty-email match. | `200 {assignments:AssignmentDetail[],pagination}`, newest `assignedAt` first, all statuses. | Always assignment org filter. Filters do not require scenario to remain published. |
| POST `/assignments`; `assignments:write` | Strict target as Rules 6–7; scenario required. | `201 {assignment,practiceUrl,created:true,emailSent}` for new/reopened; `200 {assignment,practiceUrl,created:false}` for pending/used, with **no `emailSent`**. | `400 email or userId and a valid scenario slug are required`; `404 User not found`; `404 Scenario not found`; `403 API key creator is no longer an organization trainer`; credit message `409`. Supplied user/scenario resolved in key org. |
| GET `/assignments/{id}`; `assignments:read` | Raw assignment ID. | `200 {assignment:AssignmentDetail}`. | `404 Assignment not found` for unknown/foreign; no status/archive exclusion. |
| PATCH `/assignments/{id}`; `assignments:write` | Strict optional target fields; one required. Email max 320; nonempty userId; scenario regex as POST. | `200 {assignment,practiceUrl,changed:false}` for same pair; changed result adds `emailSent` and `changed:true`. | `400 Supply an email, userId, or scenario`; `404 Assignment not found`, `User not found`, `Scenario not found`; creator `403` as POST; `409 That learner already has this scenario assigned`; credit message `409`. Current assignment and replacement target lookups scoped to org. |
| DELETE `/assignments/{id}`; `assignments:write` | Raw assignment ID. | `204`, hard delete, no credit refund/email. Session foreign keys become null. | `404 Assignment not found` for missing/foreign or repeat DELETE. |

### Sessions

Source: `web/app/api/v1/sessions/route.ts`, `web/app/api/v1/sessions/[id]/route.ts`.

`SessionSummary` always selects `id,userId,personaSlug,personaVersion,agentSlug,agentVersion,assignmentId,status,mode,contextName,createdAt,startedAt,endedAt`. Nullable fields are returned, not omitted. `assignmentId` can be null, including after assignment deletion (`web/prisma/schema.prisma` `InterviewSession`).

| Method + path; scope | Input / validation | Success | Other handled errors / isolation |
| --- | --- | --- | --- |
| GET `/sessions`; `sessions:read` | Pagination; optional `status` in `assigned,activating,active,completed,abandoned,failed,revoked`; `userId`, `scenario`, `assignmentId` nonempty strings if supplied; `from`,`to` ISO datetime with offset allowed. Empty values treated as absent. No from≤to check. | `200 {sessions:SessionSummary[],pagination}`, newest `createdAt` first. Filters combine with AND; dates bound **startedAt**, inclusive. | `400 Invalid session filters`; same-org, non-deleted role-play sessions only. Foreign filter IDs yield empty results, not `404`. |
| GET `/sessions/{id}`; `sessions:read` | Raw session ID. | `200 {session}`: summary plus raw `transcript`, `evidence`, `audioUrl`, `videoUrl`. | `404 Session not found`, also for foreign/deleted/twin session. Signing failure is logged and returns null for that recording, not an error response. |

Recording URLs are signed for 3,600 seconds. Audio uses stored `s3AudioKey`; video uses nonempty `evidence.videoS3Key`, else the standard org recording path if `videoEgressId` exists. Internal `s3AudioKey` and `videoEgressId` are stripped. The route signs keys, without checking object existence or independently checking an evidence key's org prefix (`web/app/api/v1/sessions/[id]/route.ts`, `web/lib/s3.ts` `presignedGetUrl`, `orgPrefix`).

### Separate runtime route, still under `/api/v1`

| Method + path | Input / validation | Responses / org boundary | Source |
| --- | --- | --- | --- |
| POST `/chat/completions` | Authorization header token, stripping optional case-insensitive `Bearer`; ignores `x-api-key`. Session token hash must match an activating/active/closing session. Parses JSON into the TypeScript `ChatCompletionRequest` shape (`model?`, `messages`, `tools?`, `stream?`); there is no full runtime schema validation. `messages` defaults to `[]`, `tools` to `[]`, stream to true; model output is `trainertwin-runtime`. Attachment arrays, when inspected in the learner-turn branch, require nonblank string `file_id`s available to that session. | `200` OpenAI-style JSON if stream false, otherwise SSE chunks, usage and `[DONE]`; new execution has `X-Execution-Count`, cached replay `X-Idempotent-Replay:true`. Session hash selects session/org; no caller org override or public scope/rate-limit wrapper. Structured errors `{error:{message,type,code?}}`: `401 Unauthorized: Missing runtime token`; `401 Unauthorized: Invalid or expired session token`; `400 Invalid JSON body`; `400 Invalid attachments: must be an array of { file_id: string }`; `400 Attached file is not available to this session.`; `500 Session spec unavailable`; caught pipeline failures `500` with code `internal_error`. Authorization happens outside that catch. | `web/app/api/v1/chat/completions/route.ts`, `web/lib/runtime/openai.ts` `handleCompletions`, `runCompletionPipeline`, `web/lib/interview-sessions.ts` `authorizeRuntimeSession` |

This is a runtime/session boundary only; its conversation logic belongs to [Voice agent and chat](voice-agent-and-chat.md). Replay uses the most recent completion hash derived from the session token hash, ID and normalized messages; it does not hash stream/tools/model (`web/lib/runtime/openai.ts` `computeRequestHash`, `runCompletionPipeline`).

### Key management and documentation surfaces

| Entry | Contract / source |
| --- | --- |
| Dashboard `/developer` | `web/app/dash/developer/page.tsx`, `web/components/api-key-manager.tsx`; link from `web/components/sidebar-account-menu.tsx`. |
| tRPC `page.developer` | Display key list and `canManageApiKeys`; `web/lib/pages/router.ts`. |
| GET `/api/developer/api-keys` | `200 {keys}` display fields as creation record; default-config current-org keys newest first. `403 Forbidden` without trainer. `web/app/api/developer/api-keys/route.ts`. |
| POST `/api/developer/api-keys` | Strict trimmed `{name}` length 1–60; `201 {key,record}`; `400 Enter a key name of up to 60 characters`; trainer `403 Forbidden`. Same file. |
| DELETE `/api/developer/api-keys` | Strict `{id}` nonempty string (not trimmed); `204`; `400 Missing API key ID`; trainer `403 Forbidden`; `404 API key not found` for unknown/foreign/nondefault key. Same file. |
| Better Auth catch-all `/api/auth/[...all]` | API-key plugin also registers its own lifecycle endpoints; the custom Developer handlers above are the app's UI boundary. See [Authentication](auth.md). `web/app/api/auth/[...all]/route.ts`, `web/lib/auth.ts`. |
| Published docs | Mintlify `docs/docs.json` navigates `docs/index.mdx`, `quickstart.mdx`, `authentication.mdx`, `guides/*.mdx`, `errors.mdx`, `limits.mdx`; API reference reads `docs/openapi.yaml`; download is `docs/trainer-twin-api.postman_collection.json`. |
| Emails | Invitation and assignment emails only; `web/lib/invite/org.ts` → `sendInvitationEmail`; `web/lib/external-api-assignments.ts` → `sendRolePlayAssignmentEmail`. No key email or integrator completion webhook in these routes. |

## Talks to

- **Better Auth API-key plugin:** generates/hashes keys, stores org reference/permissions/creator metadata, verifies scopes and consumes rate usage. Installed dependency is `@better-auth/api-key` 1.7.15 (`web/package.json`, `web/lib/auth.ts`, `web/lib/external-api.ts`).
- **PostgreSQL through Prisma:** keys and org-scoped resource lookups/writes; no external request chooses a tenant ID (`web/lib/db.ts`, route queries).
- **[Credits](credits.md):** POST users/assignments and changed assignment PATCH request an initial 30-credit grant; failure must be returned before inviting/assigning (`web/lib/minutes.ts` `giveStartingMinutes`, callers above).
- **[Invites and emails](invites-and-emails.md):** invitation persistence and delivery; responses carry a delivery flag, not a rollback guarantee (`web/lib/invite/org.ts`, `web/lib/external-api-assignments.ts`).
- **[Role plays](roleplays.md), [Learner portal](learner-portal.md), [Sessions](sessions.md):** scenario read and assignment link handoff; app starts sessions and owns runtime/report lifecycle. Public GET returns raw transcript/evidence, not a separate scored report field (`web/app/api/v1/sessions/[id]/route.ts`).
- **S3:** signed recording download links, one hour; signing errors become null (`web/app/api/v1/sessions/[id]/route.ts`, `web/lib/s3.ts`).
- **Mintlify:** publishes the handwritten guides and OpenAPI reference, not generated from handlers (`docs/docs.json`, `docs/package.json`).

## Edge cases and limits

- A demoted/deleted creator does not invalidate the key globally. Reads, DELETEs and user PATCH still work until expiry/revocation if verification succeeds. A disabled admin/team creator still passes the three trainer lookups because they omit `disabledAt` (`web/lib/external-api.ts`, `web/lib/external-api-assignments.ts`, `web/lib/invite/org.ts`).
- Names are account-wide: org-scoped authorization of PATCH users does not prevent the new name appearing in that account's other orgs (`web/app/api/v1/users/[id]/route.ts` PATCH). Isolation is not a promise of per-org profile names.
- An email-only assignment can target a trainer or disabled person's email; only a supplied userId is checked as an enabled learner. The grant helper also does not reject those emails. This does not bypass disabled-user checks on activation (`web/app/api/v1/assignments/*`, `web/lib/minutes.ts` `giveStartingMinutes`, `web/lib/interview-sessions.ts` `activateSession`).
- The POST assignment comment assumes dashboard/API requests are serialized and recommends a unique index if concurrency appears. The schema only indexes deployment/email; its unique deployment/member constraint allows multiple unbound null-member rows. Concurrent POST/PATCH can race or throw, with no explicit conflict recovery (`web/app/api/v1/assignments/route.ts`, `[id]/route.ts`, `web/prisma/schema.prisma`).
- A revoked/deleted assignment link is not an explicit command to stop a currently live call; DELETE does not call session closure. Deleting also clears historical `assignmentId`s; moving does not, so historical practices follow the reused ID (`web/app/api/v1/assignments/[id]/route.ts`, `web/prisma/schema.prisma`).
- Detail lookup of an unbound assignment uses a lowercased map key, but map retrieval uses stored `recipientEmail` unchanged. API writers normalize it; legacy mixed-case values may fail fallback resolution (`web/lib/external-api-assignments.ts` `assignmentDetails`).
- Session status filtering omits `closing`, although runtime authorization accepts it; session selection does not coerce status. See open questions (`web/app/api/v1/sessions/route.ts`, `web/lib/interview-sessions.ts` `authorizeRuntimeSession`).
- No custom scope selection, bulk API invitation/assignment, credit editing, scenario writing, session start/delete or integrator callback is implemented in the resource handlers (`web/app/api/v1/`, `web/app/api/developer/api-keys/route.ts`).

## Mismatches

Audit scope: all first-party files under `docs/` (OpenAPI, every guide, authentication/quickstart/errors/limits/index, Postman, navigation and build/readme config), not dependencies or generated output. The following are discrepancies or missing contract details, not proposed changes.

### Published reference and guides versus implementation

| # | Documentation / other claim | Code today |
| --- | --- | --- |
| 1 | `docs/authentication.mdx`: every `/api/v1` request needs an org API key; `docs/index.mdx`: all responses JSON except 204; OpenAPI/Postman enumerate the integrator paths only. | POST `/api/v1/chat/completions` exists but is undocumented there, uses runtime tokens and defaults to SSE. Thus the blanket auth/format claims do not cover every route under the prefix (`web/app/api/v1/chat/completions/route.ts`, `web/lib/runtime/openai.ts`). |
| 2 | `docs/authentication.mdx`: permissions are read/write users/assignments, read sessions/scenarios. | New keys also store `sessions:write`, although no handler uses it (`web/lib/auth.ts` `defaultPermissions`). |
| 3 | `docs/limits.mdx`, `authentication.mdx`, `errors.mdx`, OpenAPI `RateLimited`: over limit returns 429. | Installed plugin emits `RATE_LIMITED`; wrapper tests only `RATE_LIMIT_EXCEEDED`, so plugin rate failures become `401 Invalid API key` (`web/lib/external-api.ts`; `@better-auth/api-key` 1.7.15 installed `dist/index.mjs` `consumeRateLimit`, `verifyApiKey`). This is a dependency-bound finding, not a live production test. |
| 4 | Same docs: 120 requests per minute; errors guide says wait for next window. | Plugin uses time since **last request**, not a calendar/fixed first-request window. Continued accepted activity extends time until reset; reset needs >60 seconds since last request (`evaluateRateLimit` in that dependency). |
| 5 | `docs/authentication.mdx` broadly lists creator-no-longer-trainer as an authentication 403. | Only POST users and POST/PATCH assignments check creator membership; reads, DELETEs and name PATCH do not. Missing metadata chooses another trainer; disabled trainer memberships pass (`web/lib/external-api.ts`, `web/lib/invite/org.ts`, `web/lib/external-api-assignments.ts`). |
| 6 | `docs/errors.mdx`: replace with a current “owner or admin”; Developer page denial copy says only owners/admins manage keys. | Current roles are admin/team/user; enabled team members manage keys too (`web/lib/org.ts`, `web/lib/pages/router.ts` `developer`, `web/app/dash/developer/page.tsx`). |
| 7 | OpenAPI security has only `ApiKeyAuth` (`x-api-key`). | Bearer org keys are accepted too (correctly described in `docs/authentication.mdx`), with header precedence left undocumented (`web/lib/external-api.ts` `externalApiKey`). |
| 8 | `docs/limits.mdx`: another org's resource returns 404. | True for resource detail/ID mutations, not collection filters: foreign user/assignment/scenario IDs yield empty `200` lists. Explicit assignment email overrides userId filter (`web/app/api/v1/assignments/route.ts` GET, `sessions/route.ts` GET). |
| 9 | OpenAPI assignment GET email query has `format: email`. | GET does no email validation, only trims/lowercases; arbitrary strings yield matches/empty list, not 400 (`web/app/api/v1/assignments/route.ts` GET). |
| 10 | OpenAPI `AssignmentTarget.userId` and assignment PATCH `userId` allow empty string; PATCH email has no max length. | Code rejects empty IDs and email >320. POST OpenAPI already caps email at 320. Both schemas omit the trim/lowercase transforms and email/userId precedence (`web/app/api/v1/assignments/*` schemas). |
| 11 | OpenAPI / assignment guides suggest userId is the learner represented by recipient email; `Assignment.userId` null means email has not joined. | Both fields may be supplied and disagree: explicit email wins, userId is still returned for supplied learner. Email-only lookup hides trainers/disabled members; null need not mean no membership (`web/app/api/v1/assignments/*`, `web/lib/external-api.ts` `findOrgLearner`). |
| 12 | `docs/guides/assignments.mdx` + OpenAPI `AssignmentDetail.user`: id/name null only when email has not joined. | Unbound disabled/trainer recipients also produce nulls. A bound member is returned without enabled/role filtering (`web/lib/external-api-assignments.ts` `assignmentDetails`). |
| 13 | `docs/errors.mdx`, assignment guide and OpenAPI promise idempotent learner/scenario creation. | Sequential requests match; concurrent requests are not protected by a unique deployment/email key or atomic upsert. Code's serialization comment is not enforced (`web/app/api/v1/assignments/route.ts`, `web/prisma/schema.prisma`). |
| 14 | `docs/guides/role-plays.mdx`: “Every response reports emailSent.” | Idempotent assignment POST and no-op PATCH omit it; GET/DELETE responses also do not carry it. Assignment guide and OpenAPI correctly limit its presence to changed/created mutations (`web/app/api/v1/assignments/*`). |
| 15 | OpenAPI `practiceCount` and assignments guide say sessions started / how often learner practised; `lastPracticedAt` is latest practice. | Failed sessions are excluded; soft-deleted sessions are not. Counts can include an earlier recipient/scenario after PATCH. Session list hides soft-deleted records, so list length and count can differ (`web/lib/external-api-assignments.ts` `assignmentDetails`, `web/app/api/v1/sessions/route.ts`). |
| 16 | `docs/guides/role-plays.mdx`: every session has the assignmentId it came from. | Direct/studio sessions can have null, and deleting an assignment sets historical references null. OpenAPI `SessionSummary.assignmentId` correctly permits null (`web/prisma/schema.prisma`, `web/app/api/v1/sessions/*`). |
| 17 | `docs/guides/sessions.mdx` session list example omits assignmentId. | Both list and detail select it on every returned session (`web/app/api/v1/sessions/*`); guide text/OpenAPI otherwise describe it. |
| 18 | Sessions guide / OpenAPI recording URL descriptions: null when no recording exists. | Null also on presign errors; conversely a key/egress ID can yield a signed URL to a missing object because existence is not checked (`web/app/api/v1/sessions/[id]/route.ts`). |
| 19 | `docs/guides/users.mdx`, OpenAPI DELETE user description: learner signed out and cannot sign in. | They retain authentication/sign-in for other enabled orgs; this org is disabled. Only last-enabled-membership disabling deletes auth sessions (`web/lib/members.ts` `setMemberDisabled`, `isDisabledUser`). |
| 20 | Assignment guide / role-plays guide: link keeps working until assignment is removed; OpenAPI describes expired as historical only. | No timestamp expiry is enforced, agreeing with repeat practice. But writers still stamp 30-day expiresAt; cancelled status, changed/reopened share code, disabled access, disabled deployment or insufficient credits can also block the old link before deletion (`web/lib/assignments.ts`, `web/app/api/v1/assignments/*`, `web/lib/pages/learner.ts`, `web/lib/interview-sessions.ts`). |
| 21 | `docs/guides/users.mdx`, OpenAPI POST users describe refreshing a pending **learner** invitation. | Refresh lookup filters org/email/status, not role, and does not rewrite role. An existing pending team invitation can be refreshed/emailed through this API and remain team; learner list still excludes it (`web/lib/invite/org.ts` `inviteLearnerByApi`, `web/app/api/v1/users/route.ts` GET). |
| 22 | `docs/guides/scenarios.mdx`: pre-existing keys were granted scenarios read by migration. | Migration only modifies keys with an assignments permission entry and no scenarios entry, not all pre-existing keys (`web/prisma/migrations/20260901120000_scenarios_api_permission/migration.sql`). |
| 23 | `docs/errors.mdx`: errors use the standard flat JSON shape, including a 500 table entry. | Resource handlers have no uniform exception catch, and runtime has nested OpenAI errors. Framework 405 is not given this JSON shape either (`web/app/api/v1/*`, `web/lib/runtime/openai.ts`). |
| 24 | Guides/POST descriptions say re-inviting or already-funded recipients are free even with no balance. | Already-funded recipients need no org balance: `giveStartingMinutes` skips reading org credits when no new grants are needed. Live/no-op assignment branches bypass the helper (`web/lib/minutes.ts`, assignment routes). |

OpenAPI's user response fields (including API `role: member`), successful mutation status codes, read-only sessions/scenarios, removed domain fields, ordinary pagination bounds, creator-403 entries on the three mutation operations, credit defaults and sequential reopen behavior otherwise match the handlers. `User.createdAt` is optional in the schema, so its omission from PATCH is not a schema violation (`docs/openapi.yaml`, routes above). `docs/quickstart.mdx`, `docs/README.md`, `docs/docs.json`, `docs/package.json` and `docs/vercel.json` add no further resource-contract discrepancy found in this source audit; no published-site/build assertion is made.

### Postman collection drift

All rows refer to `docs/trainer-twin-api.postman_collection.json` request descriptions, query lists and saved success examples. Generated `<integer>` / `<boolean>` strings are placeholders, not real wire-type examples.

| Collection item | Difference from code / OpenAPI |
| --- | --- |
| List scenarios | Says “most relevant first”; code sorts dashboard `order ASC, createdAt DESC` (`web/app/api/v1/scenarios/route.ts`). |
| Remove a learner | Says membership and assignments are removed. Code disables membership and changes access statuses; account/history stay (`web/app/api/v1/users/[id]/route.ts`, `web/lib/members.ts`). |
| Invite learner examples | Include invitation `createdAt`, absent from the actual POST projection (`web/app/api/v1/users/route.ts`). |
| Update learner example | Includes user `createdAt`, absent from PATCH projection (`web/app/api/v1/users/[id]/route.ts`). |
| List assignments | Query list lacks supported email filter (`web/app/api/v1/assignments/route.ts`). |
| List/get assignment examples | Omit `practiceCount` and `lastPracticedAt`; user examples do not show nullable pre-join id/name (`web/lib/external-api-assignments.ts`). |
| Create/change assignment examples | Omit required mutation `assignment.email`; examples show userId only, not its null possibility for email recipients (`web/lib/external-api-assignments.ts` `assignmentView`). Bodies showcase only userId/scenario, not supported email. |
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

## Open questions

1. Should rate denials be recognized as `RATE_LIMITED`, and is inactivity-based limiting intended? App tests only `RATE_LIMIT_EXCEEDED`; installed plugin emits the other code and uses `lastRequest` reset (`web/lib/external-api.ts`, `web/lib/auth.ts`, installed `@better-auth/api-key/dist/index.mjs`). Production dependency behavior was not exercised in this audit.
2. Must a creator remain **enabled** and must that requirement cover every operation? Current three mutation checks omit disabledAt, shared auth has no creator check, and legacy missing metadata selects another trainer (`web/lib/external-api-assignments.ts` `findKeyTrainer`, `web/lib/invite/org.ts`, `docs/authentication.mdx`).
3. Should supplied email and userId have to identify the same learner? Current schema accepts both and returns supplied user identity even when recipient email differs (`web/app/api/v1/assignments/*`, `docs/openapi.yaml` `AssignmentTarget`).
4. Should POST users refuse or convert an existing pending team invitation? Current refresh changes only expiry/inviter although docs call this a learner invitation (`web/lib/invite/org.ts` `inviteLearnerByApi`, `docs/guides/users.mdx`).
5. Are practice statistics intentionally lifetime-by-assignment-ID, including soft-deleted sessions and pre-move practices? The count query and sessions visibility disagree (`web/lib/external-api-assignments.ts` `assignmentDetails`, `web/app/api/v1/sessions/route.ts`).
6. Should `closing` be a supported public session status? Runtime accepts it; public filter/OpenAPI enum omit it, and returned rows are not status-normalized (`web/lib/interview-sessions.ts` `authorizeRuntimeSession`, `web/app/api/v1/sessions/route.ts`, `docs/openapi.yaml` `SessionStatus`).
7. Should recording evidence keys be checked for org prefix before signing? Detail authorizes the org session but trusts `evidence.videoS3Key`; actual safety depends on its writers. The route has no independent key-scope/existence check (`web/app/api/v1/sessions/[id]/route.ts`, `web/lib/s3.ts`).
8. Should assignment expiry timestamps be retained when no longer enforced, and should moving/deleting preserve a queryable assignment history? Writers still stamp 30 days; moving reuses the ID; deleting nulls references (`web/lib/assignments.ts`, `web/app/api/v1/assignments/[id]/route.ts`, `web/prisma/schema.prisma`).

## Tests today

| Layer | Existing coverage / source |
| --- | --- |
| API contract with mocks | `web/tests/api/v1-users-contract.test.ts`: API learner role remains member on list/get/PATCH. `web/tests/api/v1-roleplay-only.test.ts`: scenario/session role-play filters, twin 404, no session mutation exports. `web/tests/api/v1-assignments-isolation.test.ts`: foreign userId POST assignment returns 404 without exposure. These are not live HTTP/Better Auth tests. |
| Database API tests | `web/tests/api/v1-minutes.db.test.ts`: initial grant, short balance, free resend/idempotent/reopened assignment. `web/tests/api/v1-assignment-email-minutes.db.test.ts`: email reports recipient balance after grant, PATCH recipient/scenario/grant behavior and short-balance preservation. `web/tests/api/v1-roleplay-practice.db.test.ts`: assignmentId on list/detail, filtered practices/pagination/foreign isolation, counts/latest dates, failed/unstarted exclusions and live practice counting. They bypass `requireExternalApi`; guarded by `localMinutesDb` in `web/tests/lib/minutes-test-db.ts`. |
| Shared library / DB boundaries | `web/tests/lib/assignments.test.ts`: identity/share code/change helpers. `web/tests/lib/minutes-ledger.db.test.ts`, `minutes-entrypoints.db.test.ts`, `invite-roleplay-minutes.db.test.ts`: credit/invitation/assignment boundaries. `web/tests/lib/roleplay-assignment-email.test.ts`, `web/tests/lib/invite/emails.test.ts`: email content. See owning specs for their full coverage. |
| Flows | `web/tests/flows/credit-purchases.flow.test.ts` calls API invitation/assignment against credit flows with shared API auth mocked. `web/tests/flows/credits-purchase-practice.flow.test.ts` covers purchase-to-practice boundary, not key management. |
| Runtime | `web/tests/lib/runtime/runtime-stream.test.ts`: completion SSE format, usage/replay and authorization (DB/runtime fixtures, not ordinary API-key tests); `runtime-e2e.test.ts`, `runtime-check.test.ts` cover runtime behavior. See [Voice agent and chat](voice-agent-and-chat.md). |
| Browser / Python | No dedicated Developer API/key-management browser suite found in `web/e2e`; learner/credits suites cover adjacent practice behavior. No dedicated integrator/key suite found in `agent/tests` or `chat/tests`; runtime behavior belongs to their owning module. |

Most important gaps: real Better Auth key creation/hash/expiry/revocation and team permissions; actual 120-request exhaustion/status/reset; missing-scope failures; disabled/demoted/missing-metadata creator behavior; malformed/unknown-body and pagination edge cases; assignment concurrent creation, contradictory email/userId, no-op cancelled PATCH and duplicate conflicts; team-invitation refresh; negative org balance on previously funded email; count/history after move/delete/soft-delete; recording signing failure/isolation; complete OpenAPI-versus-response validation. No tests or runtime code were changed for this documentation-only task.
