# Public twins and website widgets: production runbook

Owner: the person releasing TrainerTwin web, chat and voice agent together.
Do not enable customer widgets until every preflight and post-deployment check below passes.
The local, uncommitted `plan.md` records implementation progress; this file is the tracked operational checklist.

## Verification checkpoint (2026-11-18)

Automated verification passed: 888 PostgreSQL tests, 1,172 self-contained web tests, 13 widget unit/artifact tests,
27 integrated Chromium public/settings/widget checks (including seed setup), and 20 loader/playground checks across Chromium/Firefox.
The hosted-widget Firefox suite passed 12 checks with 1 explicit native-policy introspection skip (counts include setup).
Web, widget and browser-test typechecks, changed web-file lint and the Next.js 16.4.5 production build passed.
The web unit run excludes database tests, seeded/live flow suites, legacy e2e tests, runtime-stream and persona-analysis-queue.

An approved non-production canary completed two spoken turns through real LiveKit/voice-agent/STT/TTS/chat, with
persisted transcript/recording, room cleanup and exactly-once Meteroid Sandbox usage. It used native RTC with
synthesized microphone speech, not browser permissions or physical audio hardware.

**Not release clearance:** automated browser tests still simulate transport. WebKit could not launch on this macOS host;
Safari/iOS and real-browser audio remain unverified. A live deadline-repeat was rate-limited and must run after the
window resets; do not bypass limits. Existing web dependency advisories require deployed-path review.
See [Phase 4 evidence and remaining gates](../validation/public-twins-phase4.md). Nothing has been enabled or migrated in production.

## What ships

| Component | Change | Deployment |
| --- | --- | --- |
| `web/` | Public/embedded session APIs, scoped credentials, settings, anonymous history, hosted `/embed/<id>` HTML, static widget files, deadline workflow | Existing Studio deployment |
| `widgets/` | Floating/inline loader and voice-only client; outputs into `web/public/widgets/` | Built into web; **no separate service** |
| `chat/` | Anonymous visitor context, session authorization and restricted tools | Existing chat brain deployment |
| `agent/` | Voice-only anonymous input, runtime-token forwarding and absolute deadlines | Existing LiveKit agent deployment |

Use one compatible release across these components. The public embed ID is the existing twin `Agent.id`, not an API key.
There is no new Bots page, bot database, text-chat endpoint or ElevenLabs integration.

## 1. Before deployment

### Database and backups

- [ ] Confirm the production database and deployment environment. Never use a production URL in automated tests.
- [ ] Take/confirm a restorable database backup or provider restore point.
- [ ] Review these additive migrations in order:
  1. `20261118150000_public_twin_voice`: nullable account ownership, explicit anonymous fields, ownership checks,
     and twin-session trigger changes.
  2. `20261118151000_public_twin_org_usage`: permits null email for org-funded usage only; learner ledger rules remain.
  3. `20261118160000_widget_session_origin`: records website origin and constrains widget ownership/allowed-origin writes.
- [ ] Confirm the migration database role can alter constraints, indexes, functions and triggers.
- [ ] Confirm `DATABASE_URL_UNPOOLED` is the **direct** production connection, not a transaction pooler.

`web/scripts/vercel-build.sh` already applies migrations automatically for `VERCEL_ENV=production`, before the build,
using `DATABASE_URL_UNPOOLED`. Do not run a second competing migration job. A migration failure must stop the release.
For a manual, controlled release, the equivalent command from `web/` is:

```sh
DATABASE_URL="$DATABASE_URL_UNPOOLED" bunx prisma migrate deploy
```

Run a manual migration only with explicit production approval and no concurrent production build. Prisma applies
**all pending checked-in migrations**, not just the three listed above: inspect the target database's migration
history first. `DATABASE_URL="$DATABASE_URL_UNPOOLED" bunx prisma migrate status` is the status check from `web/`.
If migrations were applied manually, the later production build's `migrate deploy` should find none pending;
do not remove the pipeline's schema gate.

The production build also runs the existing `backfill-scenario-item-versions.ts` and `backfill-skill-sources.ts`
after migrations. These are idempotent, non-fatal legacy backfills, not new anonymous/widget backfills. Review their
logs and resolve failures through the normal maintenance process. No bulk enablement, anonymous-account creation,
learner assignment, credit grant or widget-ID backfill is needed.

This runbook does not execute that command. Previews must use an isolated database if database verification is required;
the production build script intentionally does not migrate preview databases.

### Keys and environment variables

**No new API key or secret is required for widgets. No existing key should be removed as part of this release.**
Widget credentials use the existing service secret with a separate signing-purpose prefix.
Never paste secrets into snippets, customer websites, public configuration, screenshots, logs or this document.

| Variable | Service | Action/check |
| --- | --- | --- |
| `DATABASE_URL` | web | Retain; pooled application connection permitted |
| `DATABASE_URL_UNPOOLED` | web release | Retain/verify direct connection for migrations |
| `COPILOT_SERVICE_SECRET` | web, chat, agent | Retain; identical nonempty secret across all three |
| `CHAT_URL` | web | Verify matching chat deployment origin; web initializes `/internal/sessions` there |
| `STUDIO_URL` | chat | Verify matching web origin reachable by chat |
| `WEB_URL` | agent | Verify web origin for webhook and usage delivery |
| `LLM_BASE_URL` | agent | **Must target chat `/v1`**, not legacy web `/api/v1`; public calls reject legacy/missing configuration |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | web/agent as configured | Retain; verify same LiveKit project and dispatch target |
| `NEXT_PUBLIC_LIVEKIT_URL` | web build | Verify public WebSocket URL; baked into browser assets/configuration |
| `LIVEKIT_AGENT_NAME` / existing `AGENT_NAME` | web/agent | Verify existing dispatch name matches deployed agent |
| Existing STT/TTS/model provider credentials | agent/chat | Retain; verify funded quotas and correct production provider projects |
| `NEXT_PUBLIC_BASE_DOMAIN` | web build | Verify production family domain; existing org subdomains must route to web |
| Existing Meteroid variables and webhook secret | web | Retain; production billing tenant only in production |
| Existing S3/recording variables | web/agent | Retain; verify recording and image storage permissions |
| Existing Workflow runtime configuration | web | Retain; new durable deadline workflow must schedule/run |
| `CRON_SECRET` / existing internal secret | web | Retain; verify stale-session sweep remains scheduled |

- [ ] Check values in the secret manager/deployment UI without copying them into terminal output.
- [ ] Do **not** add an ElevenLabs key for this widget; the existing voice stack is used.
- [ ] Do **not** expose `COPILOT_SERVICE_SECRET`, LiveKit secret, Meteroid key or STT/TTS keys to the browser.
- [ ] If a secret must rotate for an independent reason, end/drain active calls first, then coordinate web/chat/agent.
  Rotation invalidates current session and widget credentials; do not rotate only one service.
- [ ] Preserve existing billing, recording, retention and privacy policies; disclose transcription/possible recording.

### Build and security gate

- [ ] Install locked dependencies in web, widgets, chat and agent as appropriate.
- [ ] Web `bun run build` now runs `build:widgets`: locked widget dependency install, then generation of
  `v1.js`, `voice-v1.js` and `voice-v1.css`. Keep the checked-in artifacts and source in sync.
- [ ] Ensure the web build can read the sibling `widgets/` directory. Verify the deployment's monorepo/root-directory
  settings include source outside `web/` (the repository already uses sibling `shared/`).
- [ ] Run widget unit/browser tests, public/widget database tests, public-page regressions, chat tests and Python tests.
- [ ] Run web/widget/chat typechecks and production builds; inspect test skips and environment limitations.
- [ ] Verify deployed Next.js is **16.4.5 or a later patched release**. This change pins 16.4.5 to fix
  GHSA-mfr8-8qww-v76h and GHSA-vc7v-qv4w-wrv8; do not deploy an older cached dependency layer.
- [ ] Re-run `bun audit --json` in `web/` and `widgets/`. The widget package audit is clean at implementation time.
  The existing web dependency tree also reports transitive DOMPurify, KaTeX, lodash-es, minimatch, nanoid,
  picomatch, undici and Zod advisories. Record owner review/remediation for the deployed paths before rollout;
  the Next patch and passing widget tests do not clear unrelated application dependency risk.
- [ ] Confirm CSP/frame headers are not overwritten by a CDN/proxy (`frame-ancestors`, `Permissions-Policy`, `no-store`).
- [ ] Confirm deployment uses Vercel's overwritten client-IP header. Non-Vercel deployments currently share a
  conservative IP bucket; configure/review a trusted-proxy policy before high-volume public use. Never trust arbitrary
  client `X-Forwarded-For` headers.

## 2. Deployment order

Use this order for the existing automatic production pipeline:

1. Clear the release gates, obtain production approval and choose one release SHA for web/chat/agent. Record the
   current service versions and database restore point. Keep customer Public access and Embed disabled. If any test
   installations are already active, disable new anonymous starts and drain their calls before switching versions.
   Check whether merging `v2` auto-deploys web; coordinate the existing release/promotion controls before merging
   so web publication cannot race ahead of the compatible chat/agent deployment.
2. Finish the environment, credential, DNS/HTTPS, build-root and provider-quota checks above. Stop if a shared secret,
   service URL or agent dispatch name disagrees. Do not rotate secrets as part of this release.
3. Deploy the compatible **chat brain**, then the **voice agent**, from that SHA through their existing deployment
   processes. Verify chat is reachable, the agent registers with the expected LiveKit project/name, and signed-in
   traffic remains healthy. Leave anonymous access disabled while web is still on the old version.
4. Release **web** through its normal production pipeline. `web/vercel.json` runs
   `sh scripts/vercel-build.sh` from `web/`, in this order:
   1. With `VERCEL_ENV=production`, apply pending Prisma migrations using `DATABASE_URL_UNPOOLED`. The three new
      migrations run in the timestamp order listed above. A failure must stop the release; do not promote web.
   2. Run the two existing idempotent backfills described above; inspect their warnings separately.
   3. Run `bun run build`: install locked widget dependencies and build widget assets, generate Prisma client, then
      build Next.js and the durable deadline workflow. Include sibling `widgets/` and `shared/` in the build context.
   4. Let the normal release process serve the successful build. Verify production migration status and deployment SHA.
   Do not start a separate manual migration job alongside this build. Production builds touch the production schema
   even if a later build step fails; retain the backup and inspect migration status before retrying.
5. Before enabling anonymous access, smoke-test existing signed-in Twin and role-play practice, assignments and credits.
   Verify org-host widget assets, CSP/Permissions Policy, Workflow runtime, and the authenticated
   `/api/internal/sessions/sweep` cron scheduled every five minutes in `web/vercel.json`.
6. Enable only a funded, approved **internal canary** twin: Public access with a 60-second limit, exact canary website
   origins and Embed enabled/saved. Use its real settings-generated URL/snippets; do not copy local development URLs.
7. Complete every post-deployment canary check below, including real browser audio, automatic deadline/room teardown,
   released reservations, transcript/recording and exactly one capped billing charge. A failure blocks customer rollout.
8. Enable customer twins/origins gradually and monitor. Record release evidence and owners; stop new starts on anomalies.

For an explicitly approved **manual migration-first** release, apply and verify migrations after steps 1–2 and
before deploying chat/agent. Then continue steps 3–8. The normal web build still performs its schema check, which
should be a no-op for migrations already applied. Do not run manual and pipeline migration jobs concurrently.

Do not automatically merge, deploy, enable all twins or grant credits as part of a code review.

## 3. Customer installation

In the twin's settings:

1. Enable Public access and select the maximum call duration.
2. In Embed, allow exact origins such as `https://example.com` and `https://www.example.com`.
   They are separate origins. Include a non-default port when used. No paths, trailing slash, wildcard or credentials.
3. Enable the widget, save, and copy its floating or inline snippet.

Customer requirements:

- HTTPS page and browser microphone support. Loopback HTTP is for development only.
- CSP permits the org host in `script-src` and `frame-src`. Loader Shadow DOM styles need an allowed style nonce
  or an appropriate `style-src` policy; copy a permitted nonce onto the installation script when using nonces.
- Top-level/ancestor `Permissions-Policy` must allow microphone delegation to the org host. The loader sets the iframe's
  microphone allowance, but cannot override a restrictive ancestor policy.
- Every ancestor of nested installations must satisfy the server's `frame-ancestors` policy.
- Use the snippet from settings once. Inline targets must already exist when the script executes.
- For SPAs, explicitly destroy the mounted widget before removing its container; see `widgets/README.md`.

The widget does not require third-party cookies. Parent messages carry lifecycle information only, never names,
transcripts or credentials. Public/domain identifiers are not secrets and domain checks are not a substitute for abuse limits.

## 4. After deployment: canary checks

- [ ] `/widgets/v1.js`, `/widgets/voice-v1.js` and `/widgets/voice-v1.css` return successfully from the org host.
- [ ] Allowed website loads floating and inline widgets; an unlisted origin is blocked by CSP and backend policy.
- [ ] Opening/minimising alone creates no billable session or microphone prompt.
- [ ] Name is required; microphone denial creates no call. No text/upload/camera/screen-share controls appear.
- [ ] Third-party cookies blocked: name → voice call still works.
- [ ] Repeat the voice lifecycle on desktop Safari and iOS Safari; local WebKit startup failure is not a passing test.
- [ ] **Live providers:** verify the agent uses the supplied name naturally, accepts multiple spoken turns, replies
  using the intended twin's skills/voice, and exposes no account memory/private documents.
- [ ] Verify audible output, captions, listening/thinking/speaking state, mute/unmute and autoplay recovery.
- [ ] Minimise/reopen preserves the active call and shows an in-progress launcher. Mobile/keyboard close returns focus.
- [ ] Hang up; then test tab close, SPA destruction and expiry at the configured short limit.
- [ ] Confirm durable deadline cleanup runs even if the browser/voice agent disappears.
- [ ] In org history, verify anonymous name, website origin, transcript, optional recording and duration.
- [ ] Confirm exactly one capped `org_usage` ledger row, null account/email, and matching Meteroid `public_call` usage.
- [ ] Verify failed activation releases reservations and shows an actionable error without provider secrets.
- [ ] Test a short balance, repeated start, parallel start, public/widget disable and removed origin.
- [ ] Confirm signed-in learner access, assignments and credits remain unchanged.

Record release SHA, deployment URLs, migration completion, canary twin/origin, timestamp, tester and outcomes
in the team's release record. Do not put visitor content or credentials into that record.

## 5. Monitoring

Watch public/widget refusal codes, activation/LiveKit errors, chat authorization failures, deadline Workflow failures,
stale-call sweep backlog, org balance/reservations, transcript webhook delivery and missing/double usage.

Expected refusals include disabled/unavailable widget, invalid/expired widget token, rate limit, active-call limit and
insufficient org funds. A sudden spike should trigger investigation, not removal of the safeguards.
Monitor public usage separately from assigned learners. Do not log bearer grants, runtime tokens, participant tokens or names.

## 6. Disable and rollback

1. Disable the affected twin's widget to block **new embedded starts**; disable Public access to block all new anonymous starts.
   Remove an origin to revoke new starts from that website. Existing calls may finish within their pinned allowance.
2. If immediate termination is required, close the affected LiveKit rooms through existing operational tooling and
   verify normal server finalization/charging. Do not just delete database rows.
3. Preserve transcripts, session rows and the append-only billing ledger. Never reset or regrant credits to hide failures.
4. Roll back to a compatible Phase 1-capable web/chat/agent release together. Leave additive columns/constraints in place;
   do not run destructive down-migrations during an incident.
5. **Do not roll back to pre-anonymous code** while anonymous rows exist: that code assumes every session has a user.
   Such a rollback requires a separately reviewed data/read-compatibility plan.
6. If widget assets are cached externally, invalidate the affected version or remove customer installation snippets.
   Keep APIs available long enough for existing sessions to end safely.
7. Confirm no active reservations remain, durable cleanup/sweep is healthy, and each ended call has one usage entry.
8. Fix, redeploy and repeat the canary checklist before re-enabling customer origins.
