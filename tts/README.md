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
follows short-lived presigned URLs, and caches reference clips locally keyed by a
version string the app returns. **New or updated voices are picked up on the next
request — no restarts.**

## Run

```bash
cp .env.example .env          # set APP_BASE_URL + APP_API_KEY (must match web's TTS_APP_KEY)
uv sync                       # python >=3.10,<3.13, CUDA >=12 GPU expected
uv run uvicorn app.main:app --host 0.0.0.0 --port 8000
```

First start downloads VoxCPM2 weights from Hugging Face (several GB).

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

ffmpeg -f s16le -ar 24000 -ac 1 -i out.pcm out.wav   # play/convert
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

- **Single worker / serialized generation** — one GPU model instance behind a lock. Concurrent sessions need batching (nano-vLLM-VoxCPM or vLLM-Omni); swap the generation internals then.
- **One cached version per voice** — new upload replaces the old clip in cache; no eviction needed while voice count is small.
- **PCM/WAV only** — no mp3/opus transcoding; clients here consume raw audio.

## Deploy (GPU host)

```bash
docker build -t trainertwin-tts .
docker run -d --gpus all -p 8000:8000 \
  --env APP_BASE_URL=https://<web-app-host> \
  --env APP_API_KEY=<same as web's TTS_APP_KEY> \
  --env TTS_API_KEY=<bearer for /v1/*> \
  -v tts-cache:/tmp/trainertwin-tts-cache \
  trainertwin-tts
```

Model weights download on first start (several GB) — mount a volume if you want
them to survive container replacement. `/healthz` returns `{"ok":true}` once the
model is loaded; the image ships a HEALTHCHECK with a 10-minute start period to
cover that.
