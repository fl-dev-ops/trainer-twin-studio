# TrainerTwin TTS

VoxCPM2 zero-shot voice cloning behind an **OpenAI-compatible API**, built for the TrainerTwin voice agent (LiveKit) and browser clients.

```
Voice agent (LiveKit) / Next.js ── POST /v1/audio/speech {model, voice, input} ──► this service
                          ◄──────── streamed PCM / complete WAV ──────────┘
                                          │
                                          │ resolve voice (id → presigned URL + transcript)
                                          ▼
                                  Next.js app server  ──► S3
                                  (Prisma owns identity)
```

Voice identity lives in the app's Postgres (`Voice` model, cuid IDs) — two users can
name a voice the same thing without collision. This service only sees opaque IDs,
resolves them to short-lived presigned URLs, and forwards those to the backend —
no local reference cache. **Voice metadata is refreshed after its cache TTL (300 seconds by default), or explicit
invalidation. After refresh, changed versions cannot select an old precomputed profile.
New/changed voices use inline cloning until new profiles are built and loaded.**

## Architecture

```
clients ──► this proxy (auth + voice resolution) ──► vLLM-Omni (VoxCPM2, batched)
```

The GPU model runs in the official `vllm/vllm-omni` image with continuous
batching (`max_num_seqs: 10` → 10 concurrent requests on a single 24 GB GPU,
~13 GiB peak). This service is a thin I/O proxy: it checks the bearer key,
asks the Next.js app for `{audioUrl, transcript}` for the voice, and forwards
`ref_audio` (the presigned URL) + `ref_text` to the backend. A matching precomputed
voice ID/version instead selects a named backend profile, skipping repeated reference
encoding. A new or changed voice safely falls back to inline cloning until rebuilt.

## Run

```bash
cp .env.example .env          # set APP_BASE_URL + APP_API_KEY + a strong TTS_API_KEY
mkdir -p voices
docker compose up --build -d          # backend on :8001 (internal), proxy on :8000
```

Dev (proxy only, backend already running elsewhere):

```bash
uv sync
TTS_BACKEND_URL=http://<gpu-host>:8001 uv run uvicorn app.main:app --host 0.0.0.0 --port 8000
```

First backend start downloads VoxCPM2 weights from Hugging Face (~5 GB) and pays
a ~60 s warmup (torch.compile + CUDA-graph capture).

## Web-app side (one-time)

1. `cd application/web && bunx prisma migrate dev --name add-voice` (adds the `Voice` model).
2. Set env on the web app:
   - `TTS_APP_KEY` — shared secret, must equal the TTS container's `APP_API_KEY`
   - `TTS_SERVICE_URL` — e.g. `http://localhost:8000`
   - `TTS_SERVICE_KEY` — only if the TTS container sets `TTS_API_KEY`

## API

OpenAI-compatible core:

```bash
# Non-streaming: complete WAV file
curl -X POST http://localhost:8000/v1/audio/speech \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TTS_API_KEY" \
  -d '{"model":"voxcpm2","voice":"<voice-cuid>","input":"Walk me through your project."}' \
  --output out.wav

# Streaming (extension): raw 16-bit PCM chunks, sample rate in X-Sample-Rate header
curl -X POST http://localhost:8000/v1/audio/speech \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TTS_API_KEY" \
  -d '{"model":"voxcpm2","voice":"<voice-cuid>","input":"What was the baseline?","stream":true}' \
  --output out.pcm -D -

ffmpeg -f s16le -ar 48000 -ac 1 -i out.pcm out.wav   # play/convert
```

Extensions:

| Endpoint | Description |
|---|---|
| `GET /v1/models` | OpenAI-shaped list; advertises `voxcpm2`. |
| `GET /v1/voices` | Voices known to the app server (proxied live). |
| `GET /healthz` | HTTP 200 only after backend/profile/batch warmup; otherwise 503. |
| `GET /livez` | Proxy process liveness, independent of GPU readiness. |

Auth: send `Authorization: Bearer <key>` on `/v1/*`. Compose requires a nonempty
`TTS_API_KEY`. Unset-key operation is supported only for isolated local development.
Initial upstream failures return 502/504 before HTTP 200 is committed. Failures after
a stream begins terminate it abnormally instead of silently returning truncated audio.

### Agent wiring

Point an OpenAI-compatible TTS client at this service (the agent's `VoxCPM2TTS`
implementation hits the Studio's `/api/tts/speech`, which proxies here):

```python
TTS(
    model="voxcpm2",
    voice="<voice-cuid>",           # from session's persona/trainer config
    base_url="http://tts-host:8000/v1",
    api_key=TTS_API_KEY,
)
```

### Browser testing

The web app has a built-in test page at **`/tts`** (upload clip + transcript → pick
voice → stream playback). It calls `/api/tts/speech`, which proxies to this service
so keys stay server-side.

## Deliberate limits

- **WAV/PCM pass-through** — no mp3/opus transcoding; clients here consume raw audio.
- **vLLM-Omni pinned to `v0.28.0`** — the project moves fast; bump deliberately and re-test.
- **Concurrent requests are batched by the backend** (`deploy/voxcpm2.yaml`, `max_num_seqs: 10`); raise that cap for more concurrency, not more GPUs.

## Deploy (GPU host)

```bash
docker compose up -d
```

### Versioned voice profiles

Generate profiles **before starting the backend**, using the pinned vLLM-Omni model
environment (the thin proxy deliberately does not install GPU libraries):

```bash
export APP_BASE_URL=https://dash.trainertwin.com
# Supply APP_API_KEY securely; do not put secrets in command arguments.
export HF_HOME=/path/to/persistent/huggingface-cache
python scripts/build_voice_profiles.py \
  --voice <voice-cuid> --output-dir ./voices \
  --revision 7936080b41163874f38610f46f438e2c0757f9fd
```

The builder uses the same continuation/reference mode as inline cloning, records
voice and model versions, bounds reference downloads, and atomically publishes the
manifest. It serializes concurrent builds and never forwards the app credential to
an audio host. Profiles contain sensitive voice features/transcripts: keep `voices/`
private and out of git. Mount the same generated directory into both containers.
Restart backend and proxy after publishing updated profiles; missing/mismatched
live voice versions fall back to inline cloning, never to a different trainer voice.

The backend model revision is pinned in Compose. A mismatched profile manifest fails
proxy startup. Readiness verifies loaded profile names and warms batches 1/2/4/8/10.
It monitors the backend process identity; a restart makes the proxy unready and
repeats warmup. `/healthz` must be used for routing; `/livez` is only liveness.
For more than one configured voice, warmup time increases. A single GPU/container
is not high availability; retain AWS rollback until the full acceptance report passes.

### Verification

```bash
uv run --group dev pytest -q
```

Tests cover version selection/fallback, malformed profile files, authorization,
metadata failures, single-flight voice resolution, streamed/WAV/PCM contracts,
upstream errors/timeouts, cancellation, readiness, backend restart warmup,
keep-alive expiry and transient health-probe tolerance.

End-to-end acceptance (contract checks, interleaved latency tiers, simulated
playback stalls, capacity tiers, idle-gap pacing and soak) against live endpoints:

```bash
AWS_KEY=... JL_KEY=... python scripts/benchmark_tts.py \
  --target aws=https://a.example=AWS_KEY --target new=https://b.example=JL_KEY \
  --voice <voice-cuid> --tiers 1,2,4 --batches 10 --idle-gap-requests 60 \
  --soak-target new --soak-seconds 600
```

The proxy expires backend keep-alives (2 s) before vLLM's server does (5 s); reusing a
connection the server is closing otherwise yields sporadic 502s after idle gaps.
One failed health probe is retried before readiness drops. Both containers use
`restart: unless-stopped`; after a backend restart the proxy stays 503 until re-warmed.

Two containers: `tts-backend` (vLLM-Omni + VoxCPM2, needs `--gpus`, weights cached
in the `hf-cache` volume) and `tts-proxy` (this service, port 8000). Only the
proxy is published. `/healthz` reports backend reachability; both images carry
HEALTHCHECKs with generous start periods to cover model load.
