# Website voice widgets

A twin can be embedded as a floating launcher. Inline mode is not currently supported. Configure it in the existing twin's **Embed**
settings; no separate bot entity/page is created. Public twin sessions, funding, limits and runtime isolation are
owned by [Public twins](public-twins.md).

## Configuration

`Agent.data.widget` is versioned alongside the twin and preserved through skill publication:

- `enabled`: false by default; both this and Public access must be enabled.
- `allowedOrigins`: up to 20 exact HTTPS origins, normalized/deduplicated. No wildcard, path, trailing slash,
  credentials, query or fragment. HTTP is limited to localhost/127.0.0.1/localhost subdomains for development.
- `welcome`: nonempty text up to 120 characters.
- `accentColor`: six-digit hex colour.

The existing `Agent.id` is the public embed ID. Settings provide a floating snippet; it contains no secret.
Only enabled org studio members may change these settings.
Code: `web/lib/widget-settings.ts`, `web/lib/twin/manage.ts`, `web/lib/twin/trpc.ts`,
`web/components/twin/widget-settings.tsx`.

## Hosting and embedding

`widgets/` builds three static files served by the existing web deployment:

- `/widgets/v1.js`: small loader, Shadow DOM styles, floating mounting and lifecycle protocol.
- `/widgets/voice-v1.js`: standalone voice client using the native LiveKit SDK.
- `/widgets/voice-v1.css`: hosted UI stylesheet.

`GET /embed/<agentId>?parentOrigin=<exact origin>` selects org from the host, checks the twin/settings/origin and
returns HTML with per-twin `frame-ancestors`, microphone-only Permissions Policy and no-store caching.
Public profile imagery uses the same signed image URLs as the existing public twin profile.

The loader derives the widget origin from its own script URL, delegates microphone access to that origin and
validates message origin **and** source window. The widget waits for trusted parent initialization before allowing
Start. Messages contain only versioned initialization, visibility, minimise/destroy, bounded integer height,
editing-focus boolean and active-call state—never visitor data,
transcripts or credentials. Minimising preserves the iframe/call and visibly marks the launcher as in progress.
SPA owners must explicitly destroy mounts before removing containers; tab unload and durable deadlines are additional cleanup.
Fine-pointer hover expands the launcher into the card; leaving the whole surface shrinks it after a short grace
period, unless the name field is focused. Click/tap and keyboard opening remain available and pinned.
The card is content-sized, viewport-bounded and 580px high at most; resize messages accept only 280–580px.
Image preload/eager fetching happens before opening. Independent fade/translate reveals do not scale the content.
Connecting and active calls stay open regardless of pointer leave, Escape or minimise requests; no minus button is shown.
Hover/minimising/visibility messages never start or end a call.

Browser framing restrictions do not prove a human or make public IDs secret. A non-browser client can claim an
allowed origin; server-side rate, concurrency and spend limits remain mandatory.
Code: `web/app/embed/[agentId]/route.ts`, `widgets/src/loader.ts`, `widgets/src/protocol.ts`, `widgets/src/widget.ts`.

## API and identity

All calls run on the widget's org host. Mutations require a matching request Origin; no cross-origin CORS proxy
or text-completion endpoint is provided.

| Endpoint | Purpose |
| --- | --- |
| `POST /api/public/widgets/<agentId>/bootstrap` | Validate parent origin and optional signed visitor token; issue visitor token and five-minute start grant. Unbilled. |
| `POST /api/public/widgets/<agentId>/sessions` | Bearer start grant + `{name}`; recheck current public/widget settings and origin under the existing org reservation lock. |
| `POST /api/public/widgets/sessions/<sessionId>/end` | Bearer end capability; verify org/twin/visitor/website/session binding and idempotently finalize. |

The iframe uses `credentials: omit`; third-party cookies are not required. Only a signed, org/website-scoped visitor
token may be retained in iframe storage. Storage denial falls back to memory. Invalid stored visitor credentials may
trigger one unbilled bootstrap retry; charged starts are never automatically retried.

Grants use purpose-separated signing with `COPILOT_SERVICE_SECRET`. Visitor tokens last 30 days;
start grants last five minutes; session-end capabilities last 24 hours and cannot start calls or access history.
Old grants cannot bypass a disabled widget/removed origin. End remains usable after disable so existing calls can clean up.
Grant expiry is rechecked immediately before reservation, including time spent waiting for locks and balance checks.
`InterviewSession.embedOrigin` records the website and is constrained to anonymous sessions. Org history shows it.
Code: `web/lib/widget-tokens.ts`, `web/lib/widget-access.ts`, `web/app/api/public/widgets/`,
`web/prisma/migrations/20261118160000_widget_session_origin/migration.sql`.

## Verification and operations

Pure settings/token tests cover malformed values, signatures, purpose/scope and expiry. Real PostgreSQL route tests
cover reservations, current policy checks, origin tracking and repeated end/webhook charging. Separate cross-origin
browser tests cover loader lifecycle and the hosted UI; external transport simulation is not a live-provider call.
The build verifies checked-in artifacts against source.

Installation/API protocol: [widgets/README.md](../widgets/README.md).
Before/after deployment, credentials, migrations, canary checks and rollback:
[production runbook](../docs/runbooks/public-twins-and-widgets.md).
