"""Authenticated, version-aware streaming proxy for VoxCPM2/vLLM-Omni."""
import asyncio
import hmac
import logging
import re
import struct
from contextlib import asynccontextmanager, suppress

import httpx
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask

from . import config
from .chunking import chunk_text
from .profiles import VoiceProfiles
from .voices import AppUnreachable, VoiceNotFound, VoiceStore, client

logger = logging.getLogger(__name__)
store: VoiceStore | None = None
backend: httpx.AsyncClient | None = None
profiles = VoiceProfiles("", config.VOXCPM_MODEL, config.VOXCPM_MODEL_REVISION)
ready = False
backend_epoch: str | None = None


def _check_auth(authorization: str | None) -> None:
    if not config.API_KEY:
        return
    token = authorization[7:] if authorization and authorization.startswith("Bearer ") else ""
    if not hmac.compare_digest(token.encode(), config.API_KEY.encode()):
        raise HTTPException(status_code=401, detail="invalid API key")


class SpeechRequest(BaseModel):
    model: str = config.VOXCPM_MODEL_ID
    input: str
    voice: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")
    response_format: str = "wav"
    stream: bool = False


def build_payload(req: SpeechRequest, meta: dict) -> dict:
    name = profiles.select(req.voice, meta)
    payload = {
        "model": config.VOXCPM_MODEL, "input": req.input,
        "voice": name or "default", "response_format": "pcm" if req.stream else req.response_format,
        "stream": req.stream,
    }
    if name is None:
        payload["ref_audio"] = meta["audioUrl"]
        if meta.get("transcript"):
            payload["ref_text"] = meta["transcript"]
    if req.stream:
        payload["stream_format"] = "audio"
    return payload


def _chunk_payload(req: SpeechRequest, meta: dict, chunk: str, stream: bool) -> dict:
    payload = build_payload(req, meta)
    payload.update(input=chunk, response_format="pcm", stream=stream)
    if stream:
        payload["stream_format"] = "audio"
    else:
        payload.pop("stream_format", None)
    return payload


async def _open_audio(payload: dict):
    upstream = None
    try:
        upstream = await backend.send(backend.build_request("POST", "/v1/audio/speech", json=payload), stream=True)
        if upstream.status_code != 200:
            raise HTTPException(status_code=502, detail="TTS backend rejected synthesis")
        iterator = upstream.aiter_bytes()
        first = await anext(iterator, b"")
        if not first:
            raise HTTPException(status_code=502, detail="TTS backend returned empty audio")
        return upstream, iterator, first
    except BaseException as cause:
        if upstream is not None:
            await upstream.aclose()
        if isinstance(cause, httpx.TimeoutException):
            raise HTTPException(status_code=504, detail="TTS backend timed out") from cause
        if isinstance(cause, httpx.HTTPError):
            raise HTTPException(status_code=502, detail="TTS backend unavailable") from cause
        raise


async def _warm_backend() -> None:
    global ready, backend_epoch
    health = await backend.get("/health", timeout=5)
    health.raise_for_status()
    if not profiles.entries:
        ready = True
        return
    metrics = await backend.get("/metrics", timeout=5)
    metrics.raise_for_status()
    epoch = re.search(r"^process_start_time_seconds\s+(\S+)", metrics.text, re.MULTILINE)
    if epoch is None:
        raise RuntimeError("Backend process identity is unavailable")
    if ready and backend_epoch == epoch[1]:
        return
    ready = False
    response = await backend.get("/v1/audio/voices", timeout=10)
    response.raise_for_status()
    available = set(response.json()["voices"])
    if set(profiles.entries.values()) - available:
        raise RuntimeError("Configured profiles are not loaded by the backend")
    warm_texts = (
        "Ready for the next question.",
        "Please describe the approach you would use and explain the trade-offs you considered.",
    )
    for voice_id in dict.fromkeys(key[0] for key in profiles.entries):
        try:
            meta = await store.resolve(voice_id)
        except VoiceNotFound:
            continue  # Deleted application voices must not be resurrected from model profiles.
        for concurrency in config.TTS_WARMUP_CONCURRENCY:
            async def warm_one(index):
                req = SpeechRequest(voice=voice_id, input=warm_texts[index % 2], stream=True)
                upstream, iterator, first = await _open_audio(build_payload(req, meta))
                try:
                    size = len(first)
                    async for piece in iterator:
                        size += len(piece)
                    if size % 2:
                        raise RuntimeError("Warmup returned malformed PCM")
                finally:
                    await upstream.aclose()
            results = await asyncio.gather(*(warm_one(i) for i in range(concurrency)), return_exceptions=True)
            if any(isinstance(result, BaseException) for result in results):
                raise RuntimeError("Backend warmup failed")
    backend_epoch = epoch[1]
    ready = True
    logger.info("TTS profiles and batch sizes warmed; backend ready")


async def _monitor_backend() -> None:
    global ready, backend_epoch
    while True:
        try:
            await _warm_backend()
        except Exception as cause:
            ready, backend_epoch = False, None
            logger.warning("TTS not ready: %s", type(cause).__name__)
        await asyncio.sleep(5)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global store, backend, profiles, ready, backend_epoch
    ready, backend_epoch = False, None
    profiles = VoiceProfiles(config.TTS_CUSTOM_VOICE_DIR, config.VOXCPM_MODEL, config.VOXCPM_MODEL_REVISION)
    app_http = client()
    backend = httpx.AsyncClient(base_url=config.TTS_BACKEND_URL,
                               timeout=httpx.Timeout(config.TTS_BACKEND_TIMEOUT_SECONDS, connect=10, pool=30))
    store = VoiceStore(app_http)
    monitor = asyncio.create_task(_monitor_backend())
    try:
        yield
    finally:
        ready = False
        monitor.cancel()
        with suppress(asyncio.CancelledError):
            await monitor
        await store.close()
        await app_http.aclose()
        await backend.aclose()


app = FastAPI(title="TrainerTwin TTS", lifespan=lifespan)


def _wav_header(num_samples: int) -> bytes:
    data_bytes = num_samples * 2
    return struct.pack("<4sI4s4sIHHIIHH4sI", b"RIFF", 36 + data_bytes, b"WAVE", b"fmt ", 16,
                       1, 1, config.SAMPLE_RATE, config.SAMPLE_RATE * 2, 2, 16, b"data", data_bytes)


@app.post("/v1/audio/speech")
async def speech(req: SpeechRequest, authorization: str | None = Header(None)):
    _check_auth(authorization)
    if not req.input.strip() or len(req.input) > config.MAX_TEXT_CHARS:
        raise HTTPException(status_code=400, detail="input is empty or exceeds the character limit")
    if req.response_format not in {"wav", "pcm"} or req.model != config.VOXCPM_MODEL_ID:
        raise HTTPException(status_code=400, detail="unsupported response format or model")
    if not ready:
        raise HTTPException(status_code=503, detail="TTS is warming up or unavailable")
    try:
        meta = await store.resolve(req.voice)
    except VoiceNotFound as cause:
        raise HTTPException(status_code=404, detail="unknown voice") from cause
    except AppUnreachable as cause:
        raise HTTPException(status_code=502, detail="voice service unavailable") from cause
    chunks = chunk_text(req.input, target_seconds=config.TTS_CHUNK_TARGET_SECONDS,
                        max_seconds=config.TTS_CHUNK_MAX_SECONDS, words_per_second=config.TTS_WORDS_PER_SECOND)
    headers = {"X-Sample-Rate": str(config.SAMPLE_RATE), "Cache-Control": "no-store"}
    if req.stream:
        # Get actual audio before committing HTTP 200, so initial failures stay visible.
        upstream, iterator, first = await _open_audio(_chunk_payload(req, meta, chunks[0], True))

        async def pcm_stream():
            current = upstream
            try:
                yield first
                async for piece in iterator:
                    yield piece
                for chunk in chunks[1:]:
                    await current.aclose()
                    current, pieces, initial = await _open_audio(_chunk_payload(req, meta, chunk, True))
                    yield initial
                    async for piece in pieces:
                        yield piece
            except asyncio.CancelledError:
                raise
            except Exception as cause:
                logger.error("TTS stream interrupted: %s", type(cause).__name__)
                # A failed partial stream must terminate abnormally, never look like a completed clip.
                raise RuntimeError("TTS stream interrupted") from cause
            finally:
                await current.aclose()

        return StreamingResponse(pcm_stream(), media_type="audio/pcm",
                                 headers={**headers, "X-Accel-Buffering": "no"},
                                 background=BackgroundTask(upstream.aclose))
    pcm = bytearray()
    for chunk in chunks:
        upstream, pieces, first = await _open_audio(_chunk_payload(req, meta, chunk, False))
        try:
            pcm.extend(first)
            async for piece in pieces:
                pcm.extend(piece)
        except httpx.TimeoutException as cause:
            raise HTTPException(status_code=504, detail="TTS backend timed out") from cause
        except httpx.HTTPError as cause:
            raise HTTPException(status_code=502, detail="TTS backend unavailable") from cause
        finally:
            await upstream.aclose()
    if len(pcm) % 2:
        raise HTTPException(status_code=502, detail="TTS backend returned malformed PCM")
    if req.response_format == "wav":
        return Response(_wav_header(len(pcm) // 2) + bytes(pcm), media_type="audio/wav", headers=headers)
    return Response(bytes(pcm), media_type="audio/pcm", headers=headers)


@app.get("/v1/models")
def models(authorization: str | None = Header(None)):
    _check_auth(authorization)
    return {"object": "list", "data": [{"id": config.VOXCPM_MODEL_ID, "object": "model"}]}


@app.get("/v1/voices")
async def voices(authorization: str | None = Header(None)):
    _check_auth(authorization)
    try:
        return JSONResponse({"voices": await store.list_ids()})
    except AppUnreachable as cause:
        raise HTTPException(status_code=502, detail="voice service unavailable") from cause


@app.get("/healthz")
async def healthz():
    return JSONResponse({"ok": ready, "backend": config.TTS_BACKEND_URL}, status_code=200 if ready else 503)


@app.get("/livez")
async def livez():
    return {"ok": True}
