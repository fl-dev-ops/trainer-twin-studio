# Public API and studio copilot: rules

> **A rule spec.** It says how the REST API (`/api/v1`) and the studio copilot's calls into the studio *must* work;
> the code follows it, and a difference is a bug in the code. Module specs ([Public API](public-api.md),
> [Copilot](copilot.md)) describe the code. People and practice rules apply as everywhere ([People](people.md),
> [Practice](practice.md)); their refusal codes are used here too. The published contract is `docs/openapi.yaml`:
> it must describe exactly what these rules do. Drafted 12 Nov 2026.

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

## Open questions

- **Copilot service secrets.** Today one shared secret (`SCENARIO_INGEST_SECRET` with org and user headers, and
  `COPILOT_SERVICE_SECRET`) lets its holder act as any trainer of any org. Proposed: the studio proxy gives the copilot
  a short-lived signed actor token (org, user, expiry) that the copilot passes back, and one secret per direction.
  Needs changes in `copilot/` and `chat/`.
- **`invite_learners` without approval.** The copilot can add up to 100 learners (spending starting credits and
  sending emails) without the trainer confirming. Proposed: an approval card like publishing. Needs a `copilot/`
  change.
