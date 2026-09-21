# Voice opening prewarm

## Goal

Reduce the first spoken turn without changing the LiveKit/video sequence or pre-generating a greeting.

## What is actually slow

The first Eve turn does three one-time jobs:

1. `session-spec.ts` calls web `getSessionContext` and builds the system prompt.
2. The model chooses opening tools.
3. `search_style`, `session_plan`, and sometimes `surface` run before the final response.

Later turns are faster because Eve keeps the session instructions and provider prompt prefix.

## Minimal implementation

During activation, while the learner connects and watches the intro:

1. `warmChatOpening()` pins the compiled snapshot.
2. It retrieves the opening style and queues the initial surface.
3. It writes the existing small `warmOpening` JSON.
4. It calls the same cached session-context function used by the studio API.

When Eve starts the first real turn:

1. `session-spec.ts` runs once.
2. `getSessionContext` returns the Next.js Data Cache result.
3. The returned `warmOpening` block tells the brain to skip opening tools.
4. The model produces the greeting in one completion.

## Boundaries

- No database schema changes.
- No full session context duplicated into the session row.
- No generated greeting stored ahead of time.
- No timing environment variable.
- No changes to `begin-opening`; the browser still releases speech when the intro ends.
- Cold fallback remains: if warming fails, the existing first-turn path still works.

## Files

- `web/lib/session-context.ts`: canonical context builder plus 24-hour session cache.
- `web/app/api/copilot/studio/route.ts`: uses the cached builder.
- `web/lib/session-warm.ts`: primes the cache after writing `warmOpening`.

## Verification

1. Activate a real session through Next.js.
2. Confirm `[session-warm] ... warmed` before intro completion.
3. Confirm `getSessionContext` completes in tens of milliseconds.
4. Confirm the opening turn calls no `search_style`, `session_plan`, or `surface` tools.
5. Measure intro end → first audible frame separately; LiveKit/TTS delay is outside this web cache.
