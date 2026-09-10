# Trainer fidelity benchmark

Runs DeepEval conversation simulations against TrainerTwin's OpenAI-compatible runtime, then compares the trainer turns with analyzed persona source material.

```bash
cd bench
uv sync
BENCH_REFERENCE_PERSONA_SLUG=surya uv run python simulate.py
```

`web/.env` supplies `DATABASE_URL`, `OPENROUTER_API_KEY`, and `OPENROUTER_BASE_URL`. The web app must be reachable at `https://trainertwin.localhost` or `BENCH_API_URL`.

Useful settings:

- `BENCH_AGENT_SLUGS=fundamentals-depth,real-world-system-design`
- `BENCH_REFERENCE_PERSONA_SLUG=surya` — omit to use each scenario's attached persona
- `BENCH_MAX_TURNS=12`
- `BENCH_MAX_REFERENCE_SOURCES=5`
- `BENCH_FIDELITY_THRESHOLD=0.7`
- `BENCH_EVALUATION_MODEL=openai/gpt-4.1-mini`
- `BENCH_KEEP_SESSIONS=1` — keep benchmark sessions; otherwise they are deleted
- `BENCH_REPORT=results/latest.json`

The report contains the simulated transcripts plus `Trainer Fidelity`, `Conversation Completeness`, and `Role Adherence` scores.
