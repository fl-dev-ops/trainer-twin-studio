# TrainerTwin TTS

VoxCPM2 zero-shot voice cloning behind an **OpenAI-compatible API**, built for Pipecat and browser clients.

```
Pipecat / Next.js client ── POST /v1/audio/speech {model, voice, input} ──► this service
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
no local reference cache. **New or updated voices are picked up on the next
request — no restarts.**

## Architecture

```
clients ──► this proxy (auth + voice resolution) ──► vLLM-Omni (VoxCPM2, batched)
```

The GPU model runs in the official `vllm/vllm-omni` image with continuous
batching (`max_num_seqs: 10` → 10 concurrent requests on a single 24 GB GPU,
~13 GiB peak). This service is a thin I/O proxy: it checks the bearer key,
asks the Next.js app for `{audioUrl, transcript}` for the voice, and forwards
`ref_audio` (the presigned URL) + `ref_text` to the backend.

## Run

```bash
cp .env.example .env          # set APP_BASE_URL + APP_API_KEY (must match web's TTS_APP_KEY)
docker compose up -d          # backend on :8001 (internal), proxy on :8000
```

Dev (proxy only, backend already running elsewhere):

```bash
uv sync
TTS_BACKEND_URL=http://<gpu-host>:8001 uv run uvicorn app.main:app --host 0.0.0.0 --port 8000
```

First backend start downloads VoxCPM2 weights from Hugging Face (~5 GB) and pays
a ~60 s warmup (torch.compile + CUDA-graph capture).

## Web-app side (one-time)

1. `cd application/web && npx prisma migrate dev --name add-voice` (adds the `Voice` model).
2. Set env on the web app:
   - `TTS_APP_KEY` — shared secret, must equal the TTS container's `APP_API_KEY`
   - `TTS_SERVICE_URL` — e.g. `http://localhost:8000`
   - `TTS_SERVICE_KEY` — only if the TTS container sets `TTS_API_KEY`

## API

OpenAI-compatible core:

```bash
# Non-streaming: complete WAV file
curl -X POST http://localhost:8000/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"model":"voxcpm2","voice":"<voice-cuid>","input":"Walk me through your project."}' \
  --output out.wav

# Streaming (extension): raw 16-bit PCM chunks, sample rate in X-Sample-Rate header
curl -X POST http://localhost:8000/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"model":"voxcpm2","voice":"<voice-cuid>","input":"What was the baseline?","stream":true}' \
  --output out.pcm -D -

ffmpeg -f s16le -ar 48000 -ac 1 -i out.pcm out.wav   # play/convert
```

Extensions:

| Endpoint | Description |
|---|---|
| `GET /v1/models` | OpenAI-shaped list; advertises `voxcpm2`. |
| `GET /v1/voices` | Voices known to the app server (proxied live). |
| `GET /healthz` | Model loaded? |

Auth: if `TTS_API_KEY` is set, send `Authorization: Bearer <key>` on `/v1/*`.

### Pipecat wiring

Point an OpenAI-compatible TTS client at this service:

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

Two containers: `tts-backend` (vLLM-Omni + VoxCPM2, needs `--gpus`, weights cached
in the `hf-cache` volume) and `tts-proxy` (this service, port 8000). Only the
proxy is published. `/healthz` reports backend reachability; both images carry
HEALTHCHECKs with generous start periods to cover model load.
