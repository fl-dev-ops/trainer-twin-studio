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

Floating is the only supported mode. Put this script in the body. Old `data-mode="inline"` snippets,
inline embed URLs and `data-target` are rejected; copy the current floating snippet from settings.
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

Floating mounts show an intro card with the trainer portrait and a voice button when the iframe is ready.
Hover and widget initialization never request microphone access. Click/tap or keyboard activation of the voice
button opens a minimal name form on first use. Returning visitors start the call directly with that same button.
The saved name is scoped to the Twin and embedding site; **Change your name** opens the form again.
If storage is blocked, the name is remembered until the widget reloads.

The loader keeps connecting and active calls open. The name panel's chevron returns to the intro card. Escape
on the intro minimises it to a round phone button without unloading the iframe. Successful teardown returns focus
to the intro button, while failures remain retryable in the call panel. The panel is at most 340px wide and is
bounded by viewport safe areas. Connecting and silent calls leave no blank caption area. The two latest captions wrap in full and scroll if needed. Trusted resize
messages accept integers 140–4096px.
LiveKit audio tracks drive the shared Twin-session green/orange glow renderer. Photos remain in colour; initials
appear when no photo is available.
The call has no header; only connecting/reconnecting shows “Connecting…”, not speaking/listening text.
Compact captions follow Portfolio v4’s last-two-entry presentation with an older-entry fade.
Mute and end are icon-only, with accessible names.
The remaining allowance stays accessible and appears visually in the final 15 seconds.
Mute and hang-up remain distinct controls. Reduced-motion preferences disable decorative animation.
The loader stays credential-free: it receives only lifecycle status, bounded height and an editing-focus boolean,
not trainer or visitor data.
The portrait is preloaded by the hosted HTML and loaded eagerly/high-priority while the iframe is still closed.
On open/close the photo, heading, input and CTA independently fade/translate upward/downward, without scaling.
Controls become interactive when the outer surface settles, preventing moving-target clicks during expansion.
LiveKit audio is unlocked from the original call-start gesture before network awaits. There is no standalone sound
button; if a browser later blocks playback, a short message asks the visitor to tap the widget to retry audio.
The transparent name field keeps browser autofill paint clipped to text. Failed starts show “We couldn’t start the
conversation.” and a retry action. Safe failure guidance remains available through the title’s `aria-description`.
Network/provider details stay generic; microphone permission/device errors retain actionable guidance there.

Escape in the parent minimises an inactive floating panel; active calls ignore collapse requests.
Keyboard events do not cross iframe boundaries. The loader supplies `parentOrigin` and `mode=floating` in the iframe URL.

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
A destroyed handle is inert.

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
| iframe → parent | `trainertwin-widget` | `ready` | optional `intro: boolean`, to open the intro without moving focus |
| iframe → parent | `trainertwin-widget` | `close` | none |
| iframe → parent | `trainertwin-widget` | `status` | `active: boolean` |
| iframe → parent | `trainertwin-widget` | `interaction` | `editing: boolean`, name field focused; no field contents |
| iframe → parent | `trainertwin-widget` | `resize` | `height: integer`, 140–4096 only; host clips sizing to available screen |
| parent → iframe | `trainertwin-host` | `init` | none |
| parent → iframe | `trainertwin-host` | `destroy` | none |
| parent → iframe | `trainertwin-host` | `visibility` | `open: boolean`, triggers content reveal only |

The iframe installs its listener and sends `ready`; the loader replies `init`.
The loader requires both `event.source === iframe.contentWindow` and
`event.origin === widgetOrigin`, plus the versioned schema. It always sends with
an exact `targetOrigin`. `status` only updates a polite accessibility
announcement; it cannot resize the panel or start/end a call. Only a validated `resize` message from the exact
hosted frame can update the bounded panel height; arbitrary/oversized sizes are ignored. Repeated `ready`
messages receive `init` again, so hosted initialization must be idempotent.

The hosted page must validate `event.source === window.parent` and exact
`event.origin === parentOrigin`, then validate the host schema, before handling
`init` or `destroy`. Do not begin bootstrap/calls before validated `init`.
Send replies only to the validated exact `parentOrigin`.
Never put grants, tokens, visitor names, transcripts or call credentials in these
messages. `src/protocol.ts` is a dependency-free shared schema/URL helper.

## Build and verification

### Widget playground

Run `pm2 start ecosystem.config.cjs --only widgets` from the repo root (or `bun run playground` from `widgets/`).
Open [localhost:43190](http://localhost:43190). **Live design preview** renders the actual hosted card in simulated
call states. Choose **Button**, **Name**, or **Call**. The **Button** preview also lets you try the full flow.
Edit each screen separately: [`widget-intro.tsx`](src/widget-intro.tsx), [`widget-name.tsx`](src/widget-name.tsx),
or [`widget-call.tsx`](src/widget-call.tsx). Styles are in [`widget.css`](src/widget.css).
The playground refreshes the selected state on save without using a microphone, creating a session, or spending
credits. The preview and the real embed render the same component.

Under **Test a real embed**, paste a full installation snippet or `/embed/<id>` URL and click **Load widget**. The page displays the exact origin
to add in the Twin's Embed allowlist. You can remove and reload the floating mount; it never starts voice automatically.
It extracts only the loader URL, Twin ID and display mode, rather than executing pasted HTML or inline handlers.
Only load snippets from a widget server you trust.

With the existing port-8443 HTTPS proxy/SSH tunnel:

```sh
PORTLESS_PORT=8443 portless alias widget-test 43190
```

Open `https://widget-test.localhost:8443` on the computer with the SSH tunnel. Allow that exact origin on your Twin.
If the copied snippet omits the local proxy port, set **Widget server override** to
`https://<org>.trainertwin.localhost:8443`. The override is an origin, not a full path.
Use the same trusted development CA as the Studio. No extra SSH forwarding or production deployment is needed.
Stop it with `pm2 stop widgets` (or Ctrl+C when run directly). Remove the optional route with
`PORTLESS_PORT=8443 portless alias --remove widget-test`.

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
The hosted build uses `src/widget.ts` (iframe handshake and call lifecycle), `src/widget-view.tsx` (React screen shell),
and `src/widget.css`. It emits `web/public/widgets/voice-v1.js` and `web/public/widgets/voice-v1.css`.
React and LiveKit are bundled only in the hosted client. `src/loader.ts` remains the small framework-independent
launcher script.

Deployment checklist, keys, migrations and rollback: [production runbook](../docs/runbooks/public-twins-and-widgets.md).

The authoritative org route and bootstrap/session/end APIs remain in `web/`.
`/embed/[agentId]` supplies public configuration through the JSON script element
`#trainertwin-config`; do not serialize credentials into that document.
