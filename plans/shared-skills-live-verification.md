# Shared skills — real-provider verification

Status: partial live verification completed; remaining gates listed below. Local setup copied from `../application`
at the owner's request. Secrets remain ignored,
mode-0600 local environment files; no source-checkout files were edited.

## Isolated targets

- Web: `127.0.0.1:3100`; original application remains on port 3000.
- Chat: `127.0.0.1:2100`; copilot configuration points to 2101 if needed.
- PostgreSQL: `trainertwin_shared_skills_live_test`, local Unix socket.
- Broad legacy suite: separate `trainertwin_shared_skills_unit_live_test`.
- S3: `trainertwin-shared-skills-live-20261119` prefix in the configured account.
- Chroma: dedicated real local server at `127.0.0.1:8100`, temporary directory owned by this canary.
- Voice worker: `shared-skills-canary-20261119`, never the original worker name.
- Synthetic organizations/sessions only. No real learner invites, credits, or production ownership activation.

Real S3, Chroma, embedding/model calls and transport tests are recorded separately from controlled-provider tests.
LiveKit/STT/TTS success must be demonstrated, not inferred from chat or provider indexing.

## Setup incident — disclosed to owner

The first Prisma command unexpectedly read the copied base `web/.env` instead of the `.env.local` isolation override.
It applied the eight additive shared-skills migrations to the original **local** `trainertwin` database. This was an
unintended target, not an approved data migration. No rollback/reset/drop was attempted.

Read-only confirmation immediately afterward found zero Skill, SkillVersion, SessionSkill, AgentSkillVersion and
SkillOwnership rows in that database. No package backfill or ownership cutover occurred. Existing columns gained the
additive nullable/default fields and guards. The original checkout's files were not changed.

Correction: pin targets in both copied base/local environment files and explicitly pass `DATABASE_URL` /
`DATABASE_URL_UNPOOLED` on every migration/test command. Subsequent migrations targeted only the named canary database.
Never rely on implicit environment-file precedence for database operations.

## Provider prerequisite findings

The initial real Cloud attempt uploaded S3 objects successfully, but Chroma Cloud refused provisioning database 11
because the account's database limit is 10. Existing org databases were not reused or deleted. The existing
`createOrgDatabase` retry can mask the quota error with a final getDatabase 404; preserve the underlying quota evidence.

That masking bug is fixed: only native not-found triggers creation, and only native already-exists triggers a concurrent
creation re-read. Quota/auth/network/server errors propagate unchanged. Twenty-one focused tests and real local Chroma
create/existing/concurrent-provisioning checks pass. The account quota itself is not changed.

To continue without touching existing Cloud resources, a new self-hosted Chroma process/database directory was started.
Successful tests there are real-service evidence, but **not** evidence that the Cloud quota/provisioning issue is solved.

The voice worker initially trusted only the portless CA and could not verify LiveKit's public certificate chain.
A separate combined certifi/public-root plus portless CA bundle fixed configuration; TLS verification stayed enabled.
The copied voice LLM URL also needed `/v1`: `/chat/completions` returned 404 while `/v1/chat/completions` is the real
channel. Only this checkout's ignored configuration was corrected.

## Results

| Check | Actual result |
| --- | --- |
| Real S3 / embeddings / self-hosted Chroma provider canary | **12/12 pass**, 68.8 seconds |
| Real chat SSE / Eve sessions | **10 verified turns**, two each: builder, authored, single twin, mixed main twin, empty main twin |
| Corrected real twin voice call | **Pass**, 87.36 seconds, two correctly transcribed spoken inputs and two non-silent model/audio replies |
| Post-voice persistence | Session completed, five transcript entries, completed report passes `isTwinReport` |
| Post-voice package identity | Exact v1 pin retained while current package is v3; `chargesOrg = false` |
| Python agent suite | **44 pass** after correcting stale fixture/event-loop setup, no product behavior changed |
| Broad web suite with real models | Latest **1160 pass / 2 fail**; two intermittent document-grounding assertions, not declared green |
| DB regressions with controlled external providers | **974 pass / 0 fail** |
| TypeScript / build | Pass; build required retry after existing Next.js security advisory |
| New scripts / Chroma/PDF tests ESLint; changed Python Ruff | Pass |

Provider checks cover all four formats through v1/v2/v3, unchanged no-ops, original-byte preservation, pinned cached
context/search, wrong-org refusal, zero/mixed catalogs, archive, real-index loss/recovery, import/provenance and synthetic
ownership approval gates. Thirty-five HTTP requests measured median 25 ms / maximum 792 ms; these are observations on
this local setup, not a before/after production latency comparison.

Chat used 20 cumulative requests including checker-debug attempts; no additional paid reruns were made to inflate a
pass count. Similarity scores jittered between identical searches; stable source/example identities are checked
separately from scores. Three turns per session and calibration were not completed. No fabricated transcripts were
inserted to force reports.

Voice used the two-room budget: the builder attempt reached LiveKit and TTS but failed model requests on the copied
base-path configuration; the corrected twin attempt succeeded. The twin replies were domain-boundary refusals, so this
proves transport/STT/model/TTS and actual transcript/report persistence, not substantive retrieval/coaching quality.
The manually prepared twin fixture bypasses business activation/billing. No recording key was saved; recording remains
unverified because the normal web voice-start/egress lifecycle was not exercised.

Broad-suite remaining failures are `tests/lib/runtime/document-retrieval-e2e.test.ts:204,239`. The model stopped before
required document terms on that run; both checks passed unchanged in the preceding run. Their semantic assertions were
not weakened. The old PDF expectations now explicitly include the parser's current fields; the old snapshot-route test
now uses a browser token and additionally asserts refusal of the agent token. The two focused suites pass 29/29.
Existing `any` / prefer-const lint errors elsewhere in the legacy runtime-e2e test file remain; no new type escapes were
introduced. Application/new script lint passes.

### Test-environment safety findings

The first broad-unit wrapper overlay allowed real billing configuration into request construction. Logs show 18
unmatched MSW markers including the real Meteroid host; MSW blocked those requests, but the logs alone do not independently
prove network egress absence. Corrected runs overlaid `.env.test` fake payment/LiveKit/chat settings and blank email,
with zero unmatched markers and no real payment-host mentions. Real LLM and AWS credentials remained enabled with the
dedicated S3 prefix. Do not describe that wrapper as a strict credential allowlist.

The subsequent DB regression wrapper explicitly overlaid test settings, blanked AWS/Chroma credentials and used a
placeholder model key. No financial operation or real user invitation is claimed or authorized by these checks.

## Reproduce safely

Prisma must always be explicitly pinned:

```sh
DATABASE_URL='postgresql://surya@localhost:5432/trainertwin_shared_skills_live_test?host=/tmp' \
DATABASE_URL_UNPOOLED='postgresql://surya@localhost:5432/trainertwin_shared_skills_live_test?host=/tmp' \
bunx prisma migrate deploy
```

From `web/`, with the copied ignored configuration and isolated services running:

```sh
bun scripts/shared-skills-live-check.ts --apply --report=<private-report-path>
bun scripts/shared-skills-chat-check.ts --apply --turns 2 --fixtures <private-provider-report> --report <private-chat-report>
```

The chat command has a cumulative request budget; preserve earlier reports with `--prior-report` rather than starting
unbounded retries. Voice runner: `agent/scripts/shared_skills_voice_check.py --help`, using a normalized private 0600
synthetic fixture and the verified CA bundle. The retained twin voice fixture's token is no longer live after completion.
Never publish raw fixture reports or copy those tokens into source control.

The original application's port 3000 remains untouched. New web/chat/Chroma services use ports 3100/2100/8100;
the isolated voice worker was stopped after testing. Synthetic DB/S3/Chroma artifacts are retained, not broadly deleted.
Private reports/logs live under the approved OpenCode temporary directory; no secrets or learner content are in Git.

## Still required before release approval

- Increase Chroma Cloud quota and verify isolated Cloud provisioning; local success does not clear that gate.
- Resolve the intermittent document-grounding checks rather than counting favorable retries as a full green suite.
- Complete builder voice and calibration; test substantive multi-topic retrieval/coaching, three-turn cases, normal
  business voice activation/credit gating and the recording/egress lifecycle.
- Perform a genuine before/after latency comparison and approved production-data-copy migration rehearsal.
- Explicit release/ownership activation approval; no real organization was cut over.
- Resolve the existing Next.js security advisory before deployment.
