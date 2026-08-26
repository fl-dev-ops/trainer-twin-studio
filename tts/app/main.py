"""TrainerTwin TTS — VoxCPM2 voice cloning behind an OpenAI-compatible API.

Pipecat (or any OpenAI SDK client) points at this service:

    POST /v1/audio/speech
    {"model": "voxcpm2", "voice": "<voice-id>", "input": "...", "stream": true}

`voice` is an app-owned ID; references are resolved through the Next.js
server (see voices.py) and never travel through clients.
"""

import io
import logging
import threading
from contextlib import asynccontextmanager

import httpx
import numpy as np
import soundfile as sf
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel

from . import config
from .voices import AppUnreachable, VoiceNotFound, VoiceStore

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

model = None
store = None
# ponytail: single GPU => serialize generation with one lock. Concurrent
# sessions need batching or the nano-vLLM server; swap this out then.
_generate_lock = threading.Lock()


@asynccontextmanager
async def lifespan(app: FastAPI):
    global model, store
    logger.info("loading %s ...", config.VOXCPM_MODEL)
    from voxcpm import VoxCPM

    model = VoxCPM.from_pretrained(config.VOXCPM_MODEL, load_denoiser=config.LOAD_DENOISER)
    store = VoiceStore(config.CACHE_DIR)
    logger.info("ready")
    yield


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


def _generate(ref, text: str):
    """Yield float32 numpy chunks; shared by both response modes."""
    with _generate_lock:
        yield from model.generate_streaming(
            text=text,
            prompt_wav_path=str(ref.wav_path),
            prompt_text=ref.transcript,
            reference_wav_path=str(ref.wav_path),
            cfg_value=config.CFG_VALUE,
            inference_timesteps=config.INFERENCE_TIMESTEPS,
        )


@app.post("/v1/audio/speech")
def speech(req: SpeechRequest, authorization: str | None = Header(None)):
    _check_auth(authorization)
    if not req.input.strip():
        raise HTTPException(status_code=400, detail="input is empty")
    if len(req.input) > config.MAX_TEXT_CHARS:
        raise HTTPException(status_code=400, detail=f"input exceeds {config.MAX_TEXT_CHARS} chars")
    if req.response_format not in {"wav", "pcm"}:
        raise HTTPException(status_code=400, detail="response_format must be wav or pcm")

    try:
        ref = store.get(req.voice)
    except VoiceNotFound as cause:
        raise HTTPException(status_code=404, detail=str(cause)) from cause
    except AppUnreachable as cause:
        raise HTTPException(status_code=502, detail=str(cause)) from cause

    sample_rate = model.tts_model.sample_rate

    if req.stream:
        def pcm_chunks():
            for chunk in _generate(ref, req.input):
                yield (np.clip(chunk, -1.0, 1.0) * 32767).astype("<i2").tobytes()

        return StreamingResponse(
            pcm_chunks(),
            media_type="audio/pcm",
            headers={"X-Sample-Rate": str(sample_rate)},
        )

    # Non-streaming: assemble a complete WAV file.
    chunks = list(_generate(ref, req.input))
    buffer = io.BytesIO()
    sf.write(buffer, np.concatenate(chunks), sample_rate, format="WAV")
    return Response(content=buffer.getvalue(), media_type="audio/wav")


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
def healthz():
    return {"ok": model is not None}
