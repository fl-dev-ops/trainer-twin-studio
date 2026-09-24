# Voice latency experiments

## Rule

Change one variable per experiment. The instrumentation-only deployment is
`baseline-v1`; do not change model, prompts, tools, STT, TTS, endpointing, or
regions until it has at least 30 successful learner turns.

## Baseline capture

Record before the first session:

- Git commit and deployment timestamp
- Agent, chat, and web deployment regions
- STT, LLM, and TTS provider/model names
- Endpointing and interruption settings
- Team member, browser, network type, and approximate location

Have 3-5 team members conduct normal voice interviews. Include short and long
answers, at least one technical judgment, one workspace-tool turn, and one
interruption across the collected sessions. Do not force identical wording;
this baseline measures the real product path.

Export the agent logs and build the report:

```bash
cd bench
uv run python voice_latency_report.py agent.log \
  --label baseline-v1 \
  --output results/voice-baseline-v1.json
```

The primary metric is `e2eLatencyMs`, measured from the learner finishing
speech until the agent begins responding. Diagnose it with
`endOfTurnDelayMs`, `transcriptionDelayMs`, `llmTtftMs`, `ttsTtfbMs`, and
`playbackLatencyMs`.

Run the existing Eve-only benchmark separately so model/orchestration latency
is not mixed with voice transport:

```bash
cd bench
BENCH_API_URL=https://chat.trainertwin.com uv run python latency.py
```

## Experiment order

Each experiment starts from the baseline commit, changes only the named
variable, repeats the human voice sample, and reruns `latency.py` when the LLM
path is affected.

| ID | Single change | Main question |
|---|---|---|
| E1 | Disable LLM thinking/reasoning for voice | Does first-token latency fall without quality loss? |
| E2 | Reduce endpointing delay | Does speech handoff improve without clipping or false turns? |
| E3 | Remove avoidable pre-speech tool round trips | Can routine turns reach one model step? |
| E4 | Send the first complete phrase to TTS immediately | Does first audio improve while speech stays natural? |
| E5 | A/B fast LLM providers/models | Which model has the best p95 TTFT and tool reliability? |
| E6 | A/B TTS providers only if TTS remains material | Is a provider change justified by measured TTFB? |

## Decision gates

Promote an experiment only when all are true:

- At least 30 successful learner turns
- `e2eLatencyMs` p50 improves by at least 15 percent
- `e2eLatencyMs` p95 does not regress
- No increase in clipped turns, false endpoints, failed tool calls, or fallback responses
- Team review finds no meaningful loss in interview quality or trainer likeness

Long-term product targets are p50 under 1,500 ms and p95 under 2,500 ms. They
are targets, not baseline assumptions.
