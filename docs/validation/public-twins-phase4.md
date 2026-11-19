# Public twins and widgets: Phase 4 validation

Date: 2026-11-18. Scope: anonymous public voice and floating/inline website widgets.
This is a development verification record, **not production release approval**.

## Security and lifecycle corrections

| Finding | Correction | Evidence |
| --- | --- | --- |
| Anonymous participant JWT allowed camera/screen publishing outside the provided UI | Restrict anonymous `canPublishSources` to microphone; keep signed-in permissions unchanged | Real JWT signature/claims tests in `web/tests/lib/livekit-grants.test.ts`; includes room/identity binding, persisted deadline and dispatch-only runtime credentials |
| Grant could expire while blocked on the Twin row lock | Recheck expiry immediately before session insertion, after lock acquisition and balance checks | Real PostgreSQL contention test holds the Agent row, observes the blocked backend, advances time, then releases; reproduced an unauthorized reservation before the fix and returns 401/no reservation after it |
| Earlier destroy test kept the iframe alive | Add actual loader/frame removal coverage, plus an independent backend deadline/late-activation race | `web/e2e/widget.spec.ts` and `web/tests/api/widget-runtime.db.test.ts`; room closes, credentials revoke, reservation clears, repeated deadline produces one capped charge |

The removal and durable-cleanup tests exercise separate browser/backend boundaries. They do not pretend a detached
iframe can reliably deliver an end request. The persisted deadline remains the fallback.

## Automated verification

| Suite | Result |
| --- | --- |
| PostgreSQL regression | 888 passed, 50 files |
| Self-contained web regression | 1,172 passed, 143 files |
| Widget units/source-artifact parity | 13 passed |
| Chromium/Firefox loader and manual-playground browser checks | 20 passed |
| Integrated Chromium public-page and hosted-widget checks | 19 passed, including seed setup |
| Integrated Firefox hosted-widget checks | 12 passed, 1 skipped, including setup; native microphone-policy introspection unavailable |
| Official chat suite | 130 passed; typecheck/build passed |
| Python voice-agent suite | 59 passed |
| Web/widget/browser-test typechecks and changed-file lint | Passed; existing `cn` lint advisory |
| Next.js 16.4.5 production build | Passed in a separate build folder, preserving the running dev server |

Web self-contained exclusions: DB tests (run separately), seeded/live flow suites, legacy e2e tests, runtime-stream
and persona-analysis-queue. Browser UI suites use simulated microphone/LiveKit/charged-session transport; actual hosted
HTML, bootstrap and browser framing controls remain real.
Cross-origin spoofing checks use real `postMessage` events, including a same-origin sibling with the wrong source
window and the actual parent at a different origin. Firefox's inaccessible CSP-blocked frames are asserted as such,
not treated as successful widget renders.

The chat build also reported no local sandbox provider because Docker was unavailable. Public runtime tests enforce
that anonymous calls cannot use workspace/sandbox tools; the warning is not evidence that unrelated sandbox flows work.

## Real-provider canary

Explicit user approval covered temporary local endpoint configuration, provider quotas and non-production org credits.
The local database and Meteroid **Sandbox** key were verified before starting. No production settings, migrations,
credit grants, quota resets or allowlist changes were made.

- Started compatible chat and Python voice-agent services against the existing development web server.
- Used the real cookieless widget bootstrap/start/end APIs, then a native LiveKit RTC client with synthesized
  microphone speech. No text-input substitute was sent to the agent.
- Completed an opening and **two spoken user turns/two spoken replies** through LiveKit → Deepgram → chat → VoxCPM2.
- Received 5,059 audio frames, including 2,488 above the harness's non-silence threshold, and agent state transitions.
- Verified five persisted transcript turns, anonymous ownership, website origin, revoked runtime credentials,
  completed end work and no surviving LiveKit room.
- Verified exactly one `org_usage` row per created canary session, null account/email, and Meteroid delivery timestamps.
  The multi-turn call charged 65 seconds; the earlier harness attempt charged 52 seconds. Both were capped at 120 seconds.
- Verified both persisted MP4 recording objects with signed, ranged reads (206 responses and MP4 headers).
  Audio is in the composite recording; the separate `s3AudioKey` field was not populated.

The initial attempt received a name-aware spoken opening but failed because the **test harness**, not production code,
used an unsupported AudioStream context-manager API. It was ended normally; it is not counted as a successful
multi-turn test. The corrected attempt passed. Synthetic speech transcription rendered a proper noun inaccurately;
natural-microphone speech quality and name recognition are not certified by this test.

A further automatic-deadline canary was correctly refused with `429 public_call_limit`: the existing manual start
plus two canary starts exhausted the shared hourly bucket. It created no additional session. The safeguard was not
bypassed or reset. Live deadline expiry still needs a repeat after the window resets; automated deadline/race coverage passes.

Temporary chat/agent processes were stopped and the agent's original local `WEB_URL` restored afterward.
The user's web server, HTTPS proxy, SSH tunnel and manual playground were left alone.

## Remaining gates

- **Safari/iOS:** WebKit still cannot launch on this macOS host, including an independent 15-second launch attempt.
  Run native microphone, audible playback, reconnect, minimise, unload and deadline checks in a working Safari environment.
- **Real browser audio:** the successful provider canary used native RTC and synthesized speech, not a browser's
  microphone, autoplay policy or physical speakers. Trust the development CA before browser microphone testing.
- **Live automatic deadline:** repeat a funded, capped call after the hourly bucket resets, without manually ending it.
- **Existing dependency advisories:** widget audit is clean; web audit still reports DOMPurify (including critical),
  KaTeX, lodash-es, minimatch, nanoid, picomatch, undici and Zod. Do not treat successful builds/tests as audit clearance.
  Monaco/Excalidraw/Mermaid are existing deployed import paths; Workflow/AI SDK retain additional vulnerable transitive
  copies even where the direct dependency is patched. Advisory-specific deployed-path review/remediation is still required.

Deployment, environment/key checks, service order, rollback and mandatory deployed canary:
[production runbook](../runbooks/public-twins-and-widgets.md).
