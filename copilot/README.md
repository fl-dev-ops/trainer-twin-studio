# TrainerTwin Spec Copilot

Standalone [Eve](https://eve.dev) service for TrainerTwin's durable spec-design conversations.
It reads and writes Studio data only through the authenticated `STUDIO_URL/api/copilot/studio`
endpoint; it does not import the Next.js application or connect to its database directly.

## Local development

```bash
npm install
cp .env.example .env
npm run dev # http://localhost:2000
```

Use the same `COPILOT_SERVICE_SECRET` in `copilot/.env` and `web/.env`.

## Deploy to Vercel

```bash
npx eve link
npx eve deploy
```

Configure `STUDIO_URL`, `COPILOT_SERVICE_SECRET`, `OPENROUTER_API_KEY`, and optionally
`SPEC_COPILOT_MODEL` in the Copilot Vercel project. In the Studio project, set `EVE_ORIGIN`
to the deployed Copilot origin and configure the same service secret.
