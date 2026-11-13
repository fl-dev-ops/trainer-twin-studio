# Public API and studio copilot: rules

> **A rule spec.** It says how the REST API (`/api/v1`) and the studio copilot's calls into the studio *must* work;
> the code follows it, and a difference is a bug in the code. Module specs ([Public API](public-api.md),
> [Copilot](copilot.md)) describe the code. People and practice rules apply as everywhere ([People](people.md),
> [Practice](practice.md)); their refusal codes are used here too. The published contract is `docs/openapi.yaml`:
> it must describe exactly what these rules do. Drafted 12 Nov 2026.

## Integration scope

Role plays are authored in Studio. Integrations manage learners, their credits and assignments, and read the results.
The public resource remains named `scenarios` for compatibility; it means the org's role plays, not twins. This
contract does not expose a new role-play authoring or call-start API and must survive a later runtime/storage redesign.

| Integration action | Endpoint |
| --- | --- |
| List/read the org's published role plays | `GET /api/v1/scenarios`, `GET /api/v1/scenarios/{slug}` |
| List/read learners | `GET /api/v1/users`, `GET /api/v1/users/{id}` |
| Add a learner (account + org membership, no invitation acceptance step) | `POST /api/v1/users` |
| Read the org's available credits | `GET /api/v1/credits` |
| Read a learner's credits | `GET /api/v1/users/{id}/credits` |
| Give a learner credits from the org balance | `POST /api/v1/users/{id}/credits` |
| Assign/read role-play access | `POST /api/v1/assignments`, `GET /api/v1/assignments`, `GET /api/v1/assignments/{id}` |
| Read role-play sessions and existing transcripts/results/recordings | `GET /api/v1/sessions`, `GET /api/v1/sessions/{id}` |

Existing learner update/disable and assignment move/remove endpoints remain supported. Adding a new learner keeps
the existing once-only 30 starting credits; separate grants add to that allocation, never mint new org credits.
Lists are org-scoped and paginated. Existing identifiers and response fields remain compatible; runtime-specific
configuration is not a new integration dependency.

## Rules

1. **One key, one org, one person.** An API key acts in its org as its creator while they are an enabled admin or
   team member (People rule 22). A missing, unknown, expired or disabled key is `api_key_invalid` (401); a key without
   the permission for the request is `scope_missing` (403); too many requests is `rate_limited` (429, with
   `Retry-After` in seconds); a key whose creator is no longer on the team is People's `api_key_owner_gone` (403).
   An org has at most 20 keys (`too_many_keys`, when creating one in the studio).
2. **Every answer is ours.** Every `/api/v1` resource route answers through one wrapper (the agent's model-call route
   and the copilot proxy keep their own shapes): a refusal is `{ error, code }` with its
   status (the tables in the rule specs); anything else is logged and answered `internal_error` (500), never a bare
   framework 500. Inputs that fail their schema are `invalid_input` (400).
3. **The API does what the dashboard does, with the same checks.** Adding, assigning, moving and disabling learners go
   through the same services and locks as the dashboard (People rules 6–9, 17–18; Practice rule 19). A learner is
   found by id or email among the org's learners; a disabled person or a team member is refused as People says.
4. **Retrying is safe.** Repeating a request that failed with a 5xx, or timed out, gives the same end state:
   `DELETE /users/{id}` of a learner already disabled is 204 (and ends any call still running); moving a link that
   was already moved answers the learner's open link for that role play unchanged; otherwise a link that is no
   longer open can't be moved (`roleplay_access_removed`). `DELETE /assignments/{id}` removes a link nobody has
   practised on (`pending`), like the dashboard; others are `not_found`.
5. **An account is the person's.** The API may rename a learner only when that account belongs to no other org,
   disabled memberships included (`account_shared` otherwise); the same name again changes nothing.
6. **The copilot acts as its trainer.** Every studio action the copilot takes runs as the signed-in admin or team
   member it was opened by, re-checked on each call (enabled, studio), and goes through the same services and locks
   as the dashboard (role-play and twin saves take the `agent:<slug>` lock, practice rule 20). Its proxy to the
   copilot service forwards only the copilot's own session paths (its own "Session not found" otherwise).
7. **Credits use the existing user permissions.** `GET /credits` and `GET /users/{id}/credits` require `users:read`;
   `POST /users/{id}/credits` requires `users:write`, so existing integration keys remain usable. One credit is one
   minute. Org reads report spendable minutes (after grants and active trainer-call reservations), not Meteroid ids.
   Learner reads report given, used and remaining minutes. Public users stay learners (`role: member`), not studio
   members; disabled/foreign/unknown users are not returned by reads. New grants refuse disabled/studio recipients.
8. **API credit grants are durable and retry-safe.** Body: `{minutes, note?}`, a positive whole amount within the
   existing learner cap. `Idempotency-Key` is required (1–128 non-whitespace characters); the key belongs to the org,
   not a particular API key. Store it on the grant's `MinuteLedger` row, unique within the org. The same key with the
   same learner, amount and note never writes another grant; different input is `idempotency_conflict` (409).
   Membership, pause, learner cap and available org credits are checked under `minutes:<org>` then `people:<org>`.
   Retries still require a valid key and eligible learner; an already-applied grant is not recharged after pause or
   later spending. No balance replacement, credit reclaim, purchase or org-credit creation endpoint is added.
   A new grant sends the usual credits email after commit, with a key derived from its ledger id; a replay does not
   send another email. Email failure does not undo the grant. `emailSent` describes this request, not inbox delivery.
9. **Assignment decisions stay inside the mutation lock.** POST/PATCH accept either `email` or `userId`, never both.
   Recheck source status, recipient eligibility and target under the org's locks; decide unchanged/moved/replayed
   there and return that row, not a later reread. A moved source cannot produce two destinations. Removal shares the
   minutes/people locks with assignment and Start, and checks `pending` plus no sessions before deleting. This changes
   integration mutations only, not the role-play runtime or the existing closed-pair reopening/history model.
10. **Read models remain stable.** Catalog summaries expose identifiers, names and metadata, not a new runtime schema.
    The existing scenario-detail `data` field is opaque compatibility data. Session reads are role-play-only and
    include historical calls by disabled learners; deleted sessions and other orgs are hidden. Detail exposes the
    stored report/report status as well as transcript, evidence and recording links. Lists keep limit/offset/total,
    a deterministic tie-break order, and validate date ranges; the API cannot start or edit calls.

## Refusals

Same columns as [People](people.md#refusals). **Where**: R route, S service.

| Code | Status | Message | When | Where |
| --- | --- | --- | --- | --- |
| `api_key_invalid` | 401 | Send a valid API key. | Missing, unknown, expired or disabled key, or its org is gone | R |
| `scope_missing` | 403 | This API key can't {action} {resource}. | The key lacks the permission | R |
| `rate_limited` | 429 | Too many requests. Try again in {n} seconds. | The key's rate limit | R |
| `too_many_keys` | 409 | An organization can have at most 20 API keys. Revoke one first. | Creating a 21st key | R |
| `account_shared` | 409 | This person's account is also used by another organization. They can change their name in Settings. | API rename of an account in another org too | R |
| `internal_error` | 500 | Something went wrong. Try again. | Anything that isn't a refusal | R |
| `idempotency_conflict` | 409 | This Idempotency-Key was already used for a different credit grant. | Same org request key with a different learner, amount or note | S |
| `minutes` | 400 / 403 / 409 | The shared credits service's cap, pause or insufficient-balance message. | A new grant exceeds the learner cap (400), org is paused (403), or org balance is short (409) | S |

## Open questions

- **Copilot service secrets.** Today one shared secret (`SCENARIO_INGEST_SECRET` with org and user headers, and
  `COPILOT_SERVICE_SECRET`) lets its holder act as any trainer of any org. Proposed: the studio proxy gives the copilot
  a short-lived signed actor token (org, user, expiry) that the copilot passes back, and one secret per direction.
  Needs changes in `copilot/` and `chat/`.
- **`invite_learners` without approval.** The copilot can add up to 100 learners (spending starting credits and
  sending emails) without the trainer confirming. Proposed: an approval card like publishing. Needs a `copilot/`
  change.
