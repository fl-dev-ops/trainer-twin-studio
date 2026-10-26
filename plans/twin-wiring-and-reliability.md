# Twin wiring and reliability fixes

Scope: connect existing conversation settings and assignment controls, make twin report processing durable,
finish calibration-save handling, and secure the completion webhook. Keep roleplay behavior intact.

## 1. Conversation permissions and upload copy

### Reuse what roleplay already has

`components/agent-editor.tsx` has **Learner upload title** (`contextLabel`) and **Learner upload instruction**
(`contextPrompt`). `lib/context-upload.ts` resolves these into `AgentContextUpload.label/prompt`, and
`components/session/prejoin.tsx` displays them. Reuse these conventions and the existing Field/Input UI.

- Add title and instruction fields under **Before conversation start → Enable upload** in the twin edit page.
- Store the twin-specific values alongside the existing `Agent.data.twinSettings` JSON. No settings table.
- Extend the twin tRPC read/update schema to validate and return them; sensible defaults for older agents.
- Pass resolved twin permissions and upload copy to `SessionView` and `PreJoin` through their existing loaders.
- Keep upload **enabled** separate from **required**. Writing an instruction must not silently require a
  document; preserve any existing explicit requirement. The roleplay helper `applyLearnerUpload` makes
  uploads required when a prompt is given, so do not apply that behavior blindly to twins.

### Make the switches mean something

- `preScreenshare`: when disabled, do not request a screen-share permission or block joining for lack of it.
  When enabled, expose the existing screen-sharing flow.
- `preUpload`: show/hide the prejoin upload card, using its configured title and instruction.
- `duringUpload`: show/hide the in-conversation attachment control.
- Enforce session-bound document attachments on the server using the session's pinned settings, not just
  hidden UI buttons. Keep the generic personal file library endpoint working for unrelated uses.
- Prejoin uploads must support a valid twin invitation/share code before the learner has joined the org:
  `/api/upload` currently recognizes only roleplay invitations for non-members. Reuse twin access checks
  without granting extra access or consuming minutes before the session starts.
- Existing roleplay upload, required-document and entire-screen behavior remains unchanged.

Files: `twin-edit-page.tsx`, `lib/twin/trpc.ts`, `lib/context-upload.ts`, existing page/spec loaders,
`session-view.tsx`, `session/prejoin.tsx`, `app/api/upload/route.ts`, session activation/document attachment checks.

## 2. Assign-only learner management

Keep the combined configure/assign page and its existing `assignments.assign` mutation.

- Add one **Minutes per selected learner** input, default 30, using the API's existing 1–10,000 validation.
- Assign selected, currently unassigned learners when Save changes is clicked.
- Already assigned learners stay read-only; do not add revoke, remove, unassign, or edit-existing-minutes UI.
- Retain invitation delivery and blocked-org/email-failure handling.
- Change search copy to **Search by name or email**, matching the data we actually have.
- Handle partial saves truthfully: settings can succeed even if assignment fails; preserve selection for retry
  and refresh successful changes. An active assignment already exists on retry, so do not send duplicate invites.

No new table or assignment API is necessary.

## 3. Durable twin reports with Vercel Workflow

### Integration

- Install `workflow` and wrap the existing Next config with `withWorkflow` from `workflow/next`.
- Exclude `/.well-known/workflow/` from `proxy.ts`'s matcher so the SDK's internal routes are not
  redirected through subdomain/auth routing.
- Keep `processCompletedSession` as the dispatch point. **Only twin reports move into this workflow.**
  Roleplay still uses its current scheduler, generator, prompt and report schema. Twin calibrations are skipped.

### One workflow, small checkpointed steps

`workflows/twin-session-report.ts`:

1. **Read finalized session**: confirm completed, twin, not calibration; wait/retry if the final transcript
   is not ready. Re-read the DB on each readiness attempt.
2. **Generate report**: same existing twin prompt and output. Throw failures so Workflow can retry them;
   the current generator catches errors and returns null, which must not count as a successful step.
3. **Store report**: save existing `report` JSON and `reportStatus=completed`. Separate from the LLM step,
   so a DB-save retry reuses the checkpointed model result rather than making another model call.

- Use 3 retries for model/network failures, with backoff; honor rate-limit delays for HTTP 429.
  Invalid credentials/non-retryable input fail immediately. Invalid model output gets bounded retries.
- Preserve usage metering. Database writes are idempotent by session, and duplicate completion events
  do not produce competing report writes. Do not assume `start()` has an idempotencyKey option—it does not.
- Record the run ID in one nullable `InterviewSession.reportWorkflowRunId` column for deduplication and
  recovery/status inspection. **One small migration; no new application tables.**
- An enqueue failure must not strand a session in generating: reset the claim and return a retryable error
  to the producer. Detect stale generating claims/run failures using the saved run ID; recovery must not
  repeatedly launch work on every poll.
- After retry exhaustion, keep `reportStatus=failed` and log the run/session IDs for diagnosis. No exception
  messages go to the learner UI.

### Use the full final transcript

Browser finalization can arrive before the voice agent's completion webhook. The current shared finalizer
keeps the first non-empty transcript, even if it is partial.

- For **twins only**, the authenticated agent webhook may replace the browser's provisional transcript with
  the final agent transcript. Mark that source/readiness in existing evidence JSON.
- Start the workflow once completed, but wait for that readiness marker before the model step. A bounded
  wait ends as a retryable/failed run if the agent never delivers; do not generate from a partial transcript.
- Apply the same canonical transcript handling to twin calibrations. Do not overwrite their rating records.
- Preserve existing roleplay transcript-finalization behavior and tests.

### Quiet polling on the UI

- Expose sanitized report status with the existing twin session query (no stack traces/errors).
- Reuse the installed React Query/provider for status polling approximately every 3 seconds while a completed
  session's report is pending/generating; stop on terminal state and stop background polling when hidden.
- Refresh the page data when the report becomes available. Support the session detail page and the twin detail
  aggregates (Most asked) without repeatedly fetching transcripts for a status check.
- Show neutral **Preparing report…** / skeletons. On terminal failure, show **Report not available yet**,
  not an error banner or an endless spinner. Existing transcript/recording remain usable.
- Keep the report summary stored; adding a summary panel is not part of this task.

## 4. Reliable calibration saving

Reuse `CalibrationCall` and the existing `TwinCalibration` / `TwinCalibrationRating` tables.

- Await creation of the calibration before allowing rating interaction; do not silently continue without
  a calibration ID if that write fails.
- Track pending rating writes and await them before showing a saved call summary or navigating to the review.
- Check HTTP status from `/api/sessions/finalize`; retry transient network/5xx failures with a small bound.
  A resolved fetch on HTTP 500 is not a successful save.
- Keep stable turn identifiers and the reply text as rated. If final transcript segmentation differs, do not
  lose a saved rating merely because exact-string matching fails.
- Reset calibration ID, pending writes and turn counter on Speak again/retry so the new call cannot reuse
  the old call's bookkeeping.
- Intentional Back/end actions flush pending writes. On tab close, keepalive finalization and the agent webhook
  are fallback mechanisms; do not claim the browser can await saves after being killed.
- Preserve the call/conversation design and the roleplay calibration behavior. No AI report for calibrations.

## 5. Authenticate the completion webhook

- Reuse `COPILOT_SERVICE_SECRET`, which the agent already uses for internal usage reporting.
- `agent/src/recording/webhook.py` sends `Authorization: Bearer ...`.
- `app/api/sessions/webhook/route.ts` checks it with constant-time comparison **before parsing or changing data**.
- Validate the payload's session identifier, end status, transcript shape and recording fields while accepting
  the producer's existing field names. Preserve both twin and roleplay completion payloads.
- Never send the service secret to browsers; browser finalization retains its session/user ownership checks.
- Update producer and receiver together; verify credentials before deploying. Do not add an unauthenticated
  compatibility fallback.

## Implementation order

1. Secure and validate the webhook + twin-only canonical transcript handling.
2. Connect permission/upload copy + prejoin/session enforcement.
3. Add assign-only minutes input and correct save/search handling.
4. Add Workflow SDK, report steps, run-ID migration and quiet polling.
5. Fix calibration writes/finalization/restart handling.
6. Verify locally, then Vercel preview, before production.

## Acceptance checks

- Twin upload title/instruction survive save/reload and appear before the call.
- Every twin permission independently controls its intended UI; disabled attachments are refused server-side.
- First-time learner can upload through their valid twin code; another user's/another org's code is refused.
- Assignment minutes persist; invitation sent once; already assigned learners have no removal controls.
- Workflow: duplicate events, transcript arriving late, gateway timeout/429, invalid output, save failure and
  restart/resumption tested. Ready report is stored and reflected in the UI without displaying errors.
- Calibration: rating persisted, finalization failure retried, pending writes flushed, second call gets new
  bookkeeping, review shows saved ratings with the canonical transcript.
- Missing/wrong webhook credentials rejected without DB changes; valid twin and roleplay payloads work.
- Typecheck, focused tests, production build, and a live twin/calibration call in Vercel preview.
- Existing roleplay report and upload tests stay green; no roleplay report schema or prompt changes.

## Deliberately left out

Create-new-agent flow, agent deletion, unassignment, custom per-twin report prompts, new issue-reporting tables,
response-latency capture, KB/course-material upload, and a separate queue/cron service.

## Documentation checked

- https://workflow-sdk.dev/docs/getting-started/next
- https://workflow-sdk.dev/docs/foundations/errors-and-retries
- https://workflow-sdk.dev/docs/api-reference/workflow-api/start

Workflow steps are retried/checkpointed, not an exactly-once guarantee for external LLM requests. Keep writes
and metering idempotent; a crash before checkpoint persistence can still repeat an external call.
