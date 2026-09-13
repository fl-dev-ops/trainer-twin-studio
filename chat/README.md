# TrainerTwin Chat Agent (`chat/`)

Eve agent twin of `/api/v1/chat/completions` Option B: **decide the conversational move
→ retrieve the trainer's real style moments for that move → speak as the trainer.**

Like `../copilot/`, it is filesystem-first: tools live in `agent/tools/`, behavior in
`agent/instructions.md`, model in `agent/agent.ts`. The trainer's persona (Vasanth today,
100s of trainers later) comes entirely from the style vector store — nothing is hardcoded.

## Run

```bash
cd chat
npm install
STUDIO_URL=http://localhost:3000 \
COPILOT_SERVICE_SECRET=<same secret as web> \
OPENROUTER_API_KEY=<key> \
npm run dev
```

The web app proxies eve at `/api/eve/v1/*` using `EVE_ORIGIN`. Point it at this agent's
port (e.g. `EVE_ORIGIN=http://localhost:2001`) or run both and add a second origin env.

## Tools

| Tool | Studio action | What it does |
|---|---|---|
| `search_style` | `searchStyleEpisodes` | Trainer's real past speech for a conversational move (redacted: past learner names → `<name>`, with metadata: phase, speech function, sentence shape) |
| `search_knowledge` | `searchKnowledge` | Indexed technical domain references |

## Architecture (Option B pipeline)

1. **Move**: agent classifies the turn internally (probe / challenge / hint /
   acknowledge / clarify / redirect / close) — no separate LLM round trip.
2. **Style**: `search_style` retrieves 5 real trainer phrasings for exactly that move.
3. **Speak**: single generation in the trainer's voice, identity-locked to the learner's
   stated name, anti-repetition enforced by instructions.

## What was ported from the experiments

- `web/experiments/variant-option-b/handler.ts` — move → targeted style → speak flow,
  learner-name extraction, `<name>` redaction, anti-repetition rule.
- `web/lib/persona-voice.ts` `redactLearnerNames()` — applied server-side in the studio
  route so every consumer gets clean text.
