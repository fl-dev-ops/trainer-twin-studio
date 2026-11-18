# TrainerTwin browser widgets v1

The small loader mounts an org-hosted, voice-only iframe. The hosted page owns
identity, consent, microphone access, calls, credentials and billing. The loader
never reads customer page text, names, storage, cookies or the full page URL.

## Installation

Enable the twin's embed settings and allow the customer's **exact origin** first,
including scheme and non-default port. Use HTTPS in production; HTTP is supported
for local development. Server bootstrap checks and `frame-ancestors` CSP are
authoritative, not the loader.

Floating:

```html
<script
  async
  src="https://acme.example.com/widgets/v1.js"
  data-twin-id="AGENT_ID"
  data-mode="floating"
  referrerpolicy="no-referrer"
></script>
```

Inline, in a container that already exists when the async script executes:

```html
<div id="twin-slot"></div>
<script
  async
  src="https://acme.example.com/widgets/v1.js"
  data-twin-id="AGENT_ID"
  data-mode="inline"
  data-target="twin-slot"
  referrerpolicy="no-referrer"
></script>
```

Omit `data-target` to insert an inline widget immediately after the script.
Put this script in the body. `data-target` is an element ID, **not a selector**;
use a letter followed by up to 127 letters, digits, underscores or hyphens.
Invalid configuration throws without creating a widget. No user-controlled HTML
is interpolated. Multiple scripts produce independent mounts; mounting the same
script again returns its existing handle. Multiple floating installations should
normally be avoided because their fixed launchers occupy the same corner.

The iframe URL derives solely from the installation script's HTTP(S) origin:

```text
https://acme.example.com/embed/AGENT_ID?parentOrigin=https%3A%2F%2Fcustomer.example&mode=floating
```

No full customer URL or visitor identity is sent. The iframe has a descriptive
title, `referrerpolicy="no-referrer"`, sandboxed scripts/same-origin/forms access and explicit microphone delegation to the
widget origin. Customer `Permissions-Policy` must also permit that delegation.
Customer CSP must allow the script and frame origins; loader Shadow DOM styles
need permission under `style-src`. A script nonce is copied onto the style
element for nonce-based policies. Shadow DOM isolates internal styles, not the
outer mount element from deliberate customer CSS.

## Behaviour and teardown

Floating mounts start minimised. “Talk to AI twin” toggles a non-modal dialog.
Minimising hides but **does not unload** the iframe or end the call. Reopening
preserves the hosted conversation. The launcher reports expanded state, the
dialog has an accessible name, and closing returns focus to the launcher.
The panel is bounded to the viewport, with mobile sizing below 480px.

Escape in the parent minimises an open floating panel. The hosted page must
handle its own Escape key and close button by sending `close`, because keyboard
events do not cross iframe boundaries. Inline `close` has no loader effect;
the hosted conversation remains visible in inline installations.
The loader supplies `parentOrigin` and `mode` in the iframe URL. Inline UI has no
minimise button; a stray inline `close` notification never unloads the call.

After the async loader executes, the deliberately small API is available:

```js
const script = document.querySelector("script[data-twin-id]");
const handle = window.TrainerTwinWidgets.mount({ script });
handle.open();
handle.minimise();
handle.destroy();
// Equivalent idempotent teardown:
window.TrainerTwinWidgets.destroy(script);
```

`mount({ script })` reads the installation attributes; it requires an actual
`HTMLScriptElement` from the current document. It can remount after destruction.
`open`/`minimise` are no-ops for inline instances. A destroyed handle is inert.

SPAs must call `destroy` before removing the widget's container. Destroy sends
the credential-free `destroy` notification, removes the iframe and all loader
listeners, and releases the script's mount. It is not an awaited end-call RPC:
the hosted page must clean up on `pagehide`, and durable backend deadlines remain
authoritative if either cleanup signal is lost. No broad DOM mutation observer
or parent-navigation monkey patch is installed. Full page navigation naturally
unloads the iframe.

## Versioned message contract

Every message is an object using **`version: 1`**, never `v: 1`.

| Direction | Source | Type | Other fields |
| --- | --- | --- | --- |
| iframe → parent | `trainertwin-widget` | `ready` | none |
| iframe → parent | `trainertwin-widget` | `close` | none |
| iframe → parent | `trainertwin-widget` | `status` | `active: boolean` |
| parent → iframe | `trainertwin-host` | `init` | none |
| parent → iframe | `trainertwin-host` | `destroy` | none |

The iframe installs its listener and sends `ready`; the loader replies `init`.
The loader requires both `event.source === iframe.contentWindow` and
`event.origin === widgetOrigin`, plus the versioned schema. It always sends with
an exact `targetOrigin`. `status` only updates a polite accessibility
announcement; it cannot resize the panel or start/end a call. Repeated `ready`
messages receive `init` again, so hosted initialization must be idempotent.

The hosted page must validate `event.source === window.parent` and exact
`event.origin === parentOrigin`, then validate the host schema, before handling
`init` or `destroy`. Do not begin bootstrap/calls before validated `init`.
Send replies only to the validated exact `parentOrigin`.
Never put grants, tokens, visitor names, transcripts or call credentials in these
messages. `src/protocol.ts` is a dependency-free shared schema/URL helper.

## Build and verification

From `widgets/`:

```sh
bun install --frozen-lockfile
bun run build
bun test tests
bun run typecheck
bun run test:browser
```

The browser command uses the repository's existing Playwright installation in
`web/node_modules` and Chromium, Firefox and WebKit binaries, with no extra browser-test dependency.
If needed, provision Chromium with the existing Playwright CLI before running.
It starts independent customer and widget origins on ports 43181 and 43182.
`e2e/server.ts` is a concrete cross-origin fixture with restrictive
`frame-ancestors`, exact handshake checks and a synthetic live-call flag.
It is a loader test, **not a real LiveKit/provider or backend verification**.

`build.ts` minifies the loader into `web/public/widgets/v1.js`. That artifact
must be checked in so direct Next development/e2e servers can serve installation
scripts. A unit test compares it byte-for-byte against a fresh in-memory build.
The same build requires `src/widget.ts` and `src/widget.css` and emits
`web/public/widgets/voice-v1.js` and `web/public/widgets/voice-v1.css`.
The hosted UI uses package-local `livekit-client@2.23.0`; the loader itself
imports no SDK or runtime dependencies.

Deployment checklist, keys, migrations and rollback: [production runbook](../docs/runbooks/public-twins-and-widgets.md).

The authoritative org route and bootstrap/session/end APIs remain in `web/`.
`/embed/[agentId]` supplies public configuration through the JSON script element
`#trainertwin-config`; do not serialize credentials into that document.
