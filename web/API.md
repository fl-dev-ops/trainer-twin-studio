# TrainerTwin Integration API

The `/api/v1` API is server-to-server only. Generate an organization API key in **Dashboard → Profile → Developer API**, then send it as `x-api-key` (preferred) or `Authorization: Bearer <key>`.

```bash
curl https://trainertwin.com/api/v1/users \
  -H 'x-api-key: tt_…'
```

Keys are scoped to one organization, expire after one year, and allow 120 requests per minute. Every query and mutation is filtered by the key's organization. Full request/response schemas live in the published docs (`docs/`).

## Users

- `GET /api/v1/users?limit=50&offset=0` — list learners and pending invitations
- `POST /api/v1/users` with `{ "email": "learner@example.com" }` — invite a learner
- `GET /api/v1/users/:userId` — get a learner
- `PATCH /api/v1/users/:userId` with `{ "name": "New name" }` — update a learner name
- `DELETE /api/v1/users/:userId` — remove a learner from the organization; it does not delete their account

## Scenarios

Read-only: scenario configuration is dashboard-only.

- `GET /api/v1/scenarios?limit=50&offset=0` — list published scenarios with `assignmentCount`
- `GET /api/v1/scenarios/:slug` — includes the full role-play configuration (`data`)

## Sessions

- `POST /api/v1/sessions` with `{ "userId", "scenario" | "deploymentKey", "mode": "chat"|"voice", "documentId?", "idempotencyKey?" }` — activate a session in `active` state; returns `conversationToken` (chat) or a LiveKit `participantToken` + `room` (voice). Idempotency key reuses the same active session.
- `GET /api/v1/sessions?status=…&userId=…&scenario=slug&from=…&to=…&limit=50&offset=0` — statuses: `assigned`, `activating`, `active`, `completed`, `abandoned`, `failed`, `revoked`; filters on `startedAt`, sorted by creation time
- `GET /api/v1/sessions/:id` — includes transcript, evidence, and a presigned recording URL
- `DELETE /api/v1/sessions/:id` — soft delete; the record is retained but hidden from all responses

Starting a direct session abandons the learner's other active sessions for the same scenario.

## Assignments

Scenario and persona configuration remains dashboard-only. Assignment calls reference an already published scenario by slug.

- `GET /api/v1/assignments?email=…&scenario=slug&limit=50&offset=0` (`userId` remains supported)
- `POST /api/v1/assignments` with `{ "email": "…", "scenario": "scenario-slug" }` (`userId` remains supported) — idempotent; sends the practice link only when newly assigned
- `GET /api/v1/assignments/:id` — includes `status` (`pending`/`used`/`expired`/`cancelled`) and `practiceUrl`
- `PATCH /api/v1/assignments/:id` with `{ "email": "…" }`, `{ "userId": "…" }`, `{ "scenario": "…" }`, or a combination — returns a fresh `practiceUrl` when changed
- `DELETE /api/v1/assignments/:id`

JSON errors use `{ "error": "…" }` with standard HTTP status codes. Assignment and invitation email failures do not roll back persisted changes.
