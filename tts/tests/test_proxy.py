"""Test request shaping for the vLLM-Omni proxy."""

from fastapi import HTTPException
import pytest

from app import config
from app.main import SpeechRequest, _check_auth, build_payload


def test_build_payload_stream_forces_pcm():
    # stream:true always streams raw PCM, even when the client left the
    # response_format default ("wav") — same contract as the old service
    req = SpeechRequest(voice="v1", input="hello", stream=True)
    payload = build_payload(req, {"audioUrl": "https://s3/x.wav", "transcript": None})
    assert payload["response_format"] == "pcm"
    assert payload["stream"] is True
    assert payload["stream_format"] == "audio"


def test_build_payload_zero_shot():
    req = SpeechRequest(voice="v1", input="hello")
    payload = build_payload(req, {"audioUrl": "https://s3/x.wav", "transcript": None})
    assert payload["model"] == config.VOXCPM_MODEL
    assert payload["voice"] == "default"
    assert payload["ref_audio"] == "https://s3/x.wav"
    assert "ref_text" not in payload


def test_build_payload_cloning():
    req = SpeechRequest(voice="v1", input="hello", stream=True, response_format="pcm")
    payload = build_payload(req, {"audioUrl": "https://s3/x.wav", "transcript": "exact words"})
    assert payload["ref_text"] == "exact words"
    assert payload["stream"] is True
    assert payload["stream_format"] == "audio"


def test_auth():
    old = config.API_KEY
    try:
        config.API_KEY = "secret"
        with pytest.raises(HTTPException):
            _check_auth(None)
        with pytest.raises(HTTPException):
            _check_auth("Bearer wrong")
        _check_auth("Bearer secret")  # no raise
        config.API_KEY = None
        _check_auth(None)  # open when unset
    finally:
        config.API_KEY = old


def test_wav_header():
    import struct
    from app.main import _wav_header
    from app import config
    h = _wav_header(48000)
    assert h[:4] == b"RIFF" and h[8:12] == b"WAVE" and h[36:40] == b"data"
    assert struct.unpack("<I", h[40:44])[0] == 96000
    assert struct.unpack("<I", h[24:28])[0] == config.SAMPLE_RATE


@pytest.mark.asyncio
async def test_voice_store_caching():
    import httpx
    from app.voices import VoiceStore

    calls = 0

    def handler(request: httpx.Request):
        nonlocal calls
        calls += 1
        if request.url.path == "/api/tts/voices/test-voice":
            return httpx.Response(200, json={"audioUrl": "https://s3/test.wav", "transcript": "hi"})
        return httpx.Response(404)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://app")
    store = VoiceStore(client, cache_ttl=10.0)

    # First call: hits HTTP
    meta1 = await store.resolve("test-voice")
    assert meta1["audioUrl"] == "https://s3/test.wav"
    assert calls == 1

    # Second call: hits in-memory cache, no HTTP call
    meta2 = await store.resolve("test-voice")
    assert meta2["audioUrl"] == "https://s3/test.wav"
    assert calls == 1

    # Invalidate cache
    store.invalidate("test-voice")
    meta3 = await store.resolve("test-voice")
    assert calls == 2
    await client.aclose()
