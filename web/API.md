# TrainerTwin Integration API

The `/api/v1` API is server-to-server only. Generate an organization API key in **Dashboard → Profile → Developer API**, then send it as `x-api-key` (preferred) or `Authorization: Bearer <key>`.

```bash
curl https://trainertwin.com/api/v1/users \
  -H 'x-api-key: tt_…'
```

Keys are scoped to one organization, expire after one year, and allow 120 requests per minute. Every query and mutation is filtered by the key's organization.

## Users

- `GET /api/v1/users?limit=50&offset=0` — list learners and pending invitations
- `POST /api/v1/users` with `{ "email": "learner@example.com" }` — invite a learner
- `GET /api/v1/users/:userId` — get a learner
- `PATCH /api/v1/users/:userId` with `{ "name": "New name" }` — update a learner name
- `DELETE /api/v1/users/:userId` — remove a learner from the organization; it does not delete their account

## Sessions

Session records are created when learners begin role-play; integrations cannot create empty sessions.

- `GET /api/v1/sessions?status=completed&userId=…&scenario=slug&limit=50&offset=0`
- `GET /api/v1/sessions/:id` — includes transcript and evidence
- `PATCH /api/v1/sessions/:id` with `{ "status": "completed" }` or `{ "status": "abandoned" }`
- `DELETE /api/v1/sessions/:id`

## Assignments

Scenario and persona configuration remains dashboard-only. Assignment calls reference an already published scenario by slug.

- `GET /api/v1/assignments?userId=…&scenario=slug&limit=50&offset=0`
- `POST /api/v1/assignments` with `{ "userId": "…", "scenario": "scenario-slug" }` — idempotent; sends email only when newly assigned
- `GET /api/v1/assignments/:id`
- `PATCH /api/v1/assignments/:id` with `{ "userId": "…" }`, `{ "scenario": "…" }`, or both
- `DELETE /api/v1/assignments/:id`

JSON errors use `{ "error": "…" }` with standard HTTP status codes. Assignment and invitation email failures do not roll back persisted changes.
