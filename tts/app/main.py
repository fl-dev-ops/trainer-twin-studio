"""TrainerTwin TTS — thin proxy in front of vLLM-Omni serving VoxCPM2.

    client ── POST /v1/audio/speech {model, voice, input} ──► this service
                  │ resolve voice-id → presigned URL + transcript (Next.js app)
                  ▼
             vLLM-Omni  vllm serve openbmb/VoxCPM2 --omni
             (ref_audio=presigned URL, ref_text=transcript)

All heavy lifting (batching, model serving, 48 kHz streaming) happens in
vLLM-Omni. This service only adds auth, voice identity, and request shaping.
"""

import logging
import struct
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel

from . import config
from .chunking import chunk_text
from .voices import AppUnreachable, VoiceNotFound, VoiceStore, client

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

store: VoiceStore | None = None
# one backend client for the process; this proxy is pure I/O, so a handful of
# uvicorn workers is fine and each gets its own client
backend: httpx.AsyncClient | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global store, backend
    app_http = client()
    backend = httpx.AsyncClient(base_url=config.TTS_BACKEND_URL, timeout=None)
    store = VoiceStore(app_http)
    logger.info("proxy ready — backend %s, app %s", config.TTS_BACKEND_URL, config.APP_BASE_URL)
    yield
    await app_http.aclose()
    await backend.aclose()


app = FastAPI(title="TrainerTwin TTS", lifespan=lifespan)


def _check_auth(authorization: str | None) -> None:
    if not config.API_KEY:
        return
    token = authorization.removeprefix("Bearer ") if authorization else ""
    if token != config.API_KEY:
        raise HTTPException(status_code=401, detail="invalid API key")


class SpeechRequest(BaseModel):
    model: str = config.VOXCPM_MODEL_ID
    input: str
    voice: str
    response_format: str = "wav"  # wav | pcm
    stream: bool = False


def build_payload(req: SpeechRequest, meta: dict) -> dict:
    """Shape the request for the vLLM-Omni speech API."""
    # streaming on the backend is raw PCM only; mirror the old contract where
    # stream:true implies pcm regardless of response_format
    response_format = "pcm" if req.stream else req.response_format
    payload = {
        "model": config.VOXCPM_MODEL,
        "input": req.input,
        # voice field is required by the OpenAI schema; cloning is driven
        # entirely by ref_audio (+ ref_text for in-context cloning quality)
        "voice": "default",
        "ref_audio": meta["audioUrl"],
        "response_format": response_format,
        "stream": req.stream,
    }
    if meta["transcript"]:
        payload["ref_text"] = meta["transcript"]
    if req.stream:
        # raw PCM streaming on vLLM-Omni
        payload["stream_format"] = "audio"
    return payload


def _wav_header(num_samples: int) -> bytes:
    data_bytes = num_samples * 2  # s16le mono
    return struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF", 36 + data_bytes, b"WAVE", b"fmt ", 16,
        1, 1, config.SAMPLE_RATE, config.SAMPLE_RATE * 2, 2, 16, b"data", data_bytes,
    )


def _chunk_payload(req: SpeechRequest, meta: dict, chunk: str, stream: bool) -> dict:
    payload = build_payload(req, meta)
    payload["input"] = chunk
    payload["response_format"] = "pcm"
    payload["stream"] = stream
    if stream:
        payload["stream_format"] = "audio"
    else:
        payload.pop("stream_format", None)
    return payload


@app.post("/v1/audio/speech")
async def speech(req: SpeechRequest, authorization: str | None = Header(None)):
    _check_auth(authorization)
    if not req.input.strip():
        raise HTTPException(status_code=400, detail="input is empty")
    if len(req.input) > config.MAX_TEXT_CHARS:
        raise HTTPException(status_code=400, detail=f"input exceeds {config.MAX_TEXT_CHARS} chars")
    if req.response_format not in {"wav", "pcm"}:
        raise HTTPException(status_code=400, detail="response_format must be wav or pcm")

    try:
        meta = await store.resolve(req.voice)
    except VoiceNotFound as cause:
        raise HTTPException(status_code=404, detail=str(cause)) from cause
    except AppUnreachable as cause:
        raise HTTPException(status_code=502, detail=str(cause)) from cause

    chunks = chunk_text(
        req.input,
        target_seconds=config.TTS_CHUNK_TARGET_SECONDS,
        max_seconds=config.TTS_CHUNK_MAX_SECONDS,
        words_per_second=config.TTS_WORDS_PER_SECOND,
    )

    if req.stream:
        async def pcm_stream():
            for index, chunk in enumerate(chunks):
                try:
                    upstream = await backend.send(
                        backend.build_request(
                            "POST",
                            "/v1/audio/speech",
                            json=_chunk_payload(req, meta, chunk, stream=True),
                        ),
                        stream=True,
                    )
                except httpx.HTTPError:
                    logger.exception("TTS backend unreachable on chunk %d/%d", index + 1, len(chunks))
                    return
                try:
                    if upstream.status_code != 200:
                        body = (await upstream.aread()).decode(errors="replace")[:500]
                        logger.error("TTS backend error on chunk %d/%d: %s", index + 1, len(chunks), body)
                        return
                    async for piece in upstream.aiter_bytes():
                        if piece:
                            yield piece
                finally:
                    await upstream.aclose()

        return StreamingResponse(
            pcm_stream(),
            media_type="audio/pcm",
            headers={"X-Sample-Rate": str(config.SAMPLE_RATE)},
        )

    pcm = bytearray()
    for chunk in chunks:
        try:
            upstream = await backend.send(
                backend.build_request(
                    "POST",
                    "/v1/audio/speech",
                    json=_chunk_payload(req, meta, chunk, stream=False),
                ),
                stream=True,
            )
        except httpx.HTTPError as cause:
            raise HTTPException(status_code=502, detail=f"TTS backend unreachable: {cause}") from cause
        try:
            if upstream.status_code != 200:
                body = (await upstream.aread()).decode(errors="replace")[:500]
                raise HTTPException(status_code=502, detail=f"TTS backend error {upstream.status_code}: {body}")
            pcm.extend(await upstream.aread())
        finally:
            await upstream.aclose()

    if req.response_format == "wav":
        return Response(content=_wav_header(len(pcm) // 2) + bytes(pcm), media_type="audio/wav")
    return Response(content=bytes(pcm), media_type="audio/pcm")


@app.get("/v1/models")
def models(authorization: str | None = Header(None)):
    _check_auth(authorization)
    return {"object": "list", "data": [{"id": config.VOXCPM_MODEL_ID, "object": "model"}]}


@app.get("/v1/voices")
async def voices(authorization: str | None = Header(None)):
    """Extension: list voices known to the app server."""
    _check_auth(authorization)
    try:
        return JSONResponse({"voices": await store.list_ids()})
    except AppUnreachable as cause:
        raise HTTPException(status_code=502, detail=str(cause)) from cause


@app.get("/healthz")
async def healthz():
    try:
        r = await backend.get("/health")
        return {"ok": r.status_code == 200, "backend": config.TTS_BACKEND_URL}
    except httpx.HTTPError:
        return JSONResponse({"ok": False, "backend": config.TTS_BACKEND_URL}, status_code=503)
