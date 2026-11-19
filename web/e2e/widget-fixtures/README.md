# Hosted widget browser boundary

`../widget.spec.ts` uses the normal seeded web application on port 3999 and an
independent Node HTTP customer website on `http://customer.localhost:43191`.
Run it through the existing Playwright configuration:

```sh
bunx playwright test widget.spec.ts
```

The configured local `DATABASE_URL` must point to the development database from
which `e2e/env.ts` derives the isolated `_test` database. Setup seeds the test org
and administrator. The suite saves and restores the twin's public/widget settings
through the real authenticated API.

The actual embed route, CSP, loader, styles and bootstrap/token validation remain
unmocked. `widgets/e2e/build-hosted.ts` runs through the Bun CLI from Playwright's Node worker and
compiles the current production `widgets/src/widget.ts` unchanged. Its only
module replacement is `livekit-client`, supplied by `fake-livekit.ts`.

Browser permission responses and charged session start/end HTTP transport are
simulated. These tests do not connect to LiveKit, run a voice agent, record real
audio, or prove live-provider operation or session billing. The mock launch
contains separate LiveKit, runtime and end capabilities so the assertions catch
accidental credential confusion.

The destroy/late-start scenario deliberately sends the actual destroy message
without removing its iframe, allowing the pending response's best-effort cleanup
to run. Cleanup after a browsing context has actually been removed depends on
the separately tested server deadline.
