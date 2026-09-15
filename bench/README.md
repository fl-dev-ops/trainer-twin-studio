# TrainerTwin bench — DeepEval conversation testing

The home for everything that tests or simulates the agent conversation.
[DeepEval](https://deepeval.com) is the native library; every conversation
goes through the **chat bridge over HTTP** (`chat/` agent's
`/v1/chat/completions`) — bench never imports `web/` or `chat/` code.

```bash
cd bench
uv sync
uv run python simulate.py
```

`web/.env` supplies `DATABASE_URL` (read-only fixture loading) and
`COPILOT_SERVICE_SECRET` (bridge auth). Set `BENCH_ORG_ID` in `bench/.env`
(copy `bench/.env.example`) or the shell — nothing is hardcoded; scripts fail
fast with a clear error if bridge credentials are missing. The brain must be
reachable at `BENCH_API_URL` (default `http://localhost:2001`, the local eve
dev server — see `chat/README.md`; production is `https://chat.trainertwin.com`).

## What's here

| File | Use case |
|---|---|
| `simulate.py` | **Trainer fidelity** — DeepEval `ConversationSimulator` drives synthetic learners through published scenarios; scores fidelity / completeness / role adherence against the trainer's analyzed persona sources |
| `behaviors.py` | **Behaviour ladder** — 30-turn imperfect-candidate sim (false claims, hesitation, hints, whiteboard/editor requests) testing phase-locked retrieval and grounding |
| `latency.py` | 30-turn latency profile (wall, TTFT, word count, phase progression) |
| `concurrency.py` | 5 parallel sessions × 16 turns: saturation, p90 latency, tool usage |
| `models_ab.py` | Model bake-off on standardized turns (`BENCH_MODELS` env list) |
| `test_simulate.py` | Unit tests for pure logic (`deepeval test run test_simulate.py` or `uv run pytest`) |
| `results/` | Reports and historical benchmark artifacts |

Shared plumbing: `conf.py` (env/auth/defaults), `bridge.py` (the only
conversation client — one durable eve session per instance, latest-message
protocol), `scenarios.py` (read-only scenario + persona source loading),
`learners.py` (synthetic learner personas), `metrics.py`, `checks.py`.

## Settings

- `BENCH_API_URL=http://localhost:2001` — bridge base URL
- `BENCH_MODEL=trainertwin-runtime` — request model (both backends resolve it to the brain's default)
- `BENCH_AGENT_SLUG` / `BENCH_PERSONA_SLUG` — defaults for behaviors + perf scripts (`impact-quantification` / `Vasanth`)
- `BENCH_AGENT_SLUGS=fundamentals-depth,real-world-system-design` — scenarios for `simulate.py`
- `BENCH_REFERENCE_PERSONA_SLUG=surya` — score against a specific trainer persona (omit to use each scenario's own)
- `BENCH_MAX_TURNS=12`, `BENCH_MAX_REFERENCE_SOURCES=5`, `BENCH_FIDELITY_THRESHOLD=0.7`
- `BENCH_EVALUATION_MODEL=openai/gpt-4.1-mini` — DeepEval simulator/judge model
- `BENCH_REPORT=results/custom.json` — omit to write `results/YYYYMMDD-HHMMSS.json`
- `BENCH_MODELS` — comma-separated model list for `models_ab.py`

Reports contain the simulated transcripts plus `Trainer Fidelity`,
`Conversation Completeness`, and `Role Adherence` scores.
