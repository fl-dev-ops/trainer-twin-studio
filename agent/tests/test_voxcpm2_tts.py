from __future__ import annotations

import pytest
from tts.voxcpm2 import VoxCPM2TTS, build_voxcpm2_tts


class _Content:
    async def iter_any(self):
        yield b"\x00\x00" * 160
        yield b"\x00\x00" * 320


class _Response:
    status = 200

    def __init__(self):
        self.headers = {"Content-Type": "audio/pcm", "X-Sample-Rate": "48000"}
        self.content = _Content()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass


class _Session:
    closed = False

    def post(self, endpoint, **kwargs):
        self.endpoint = endpoint
        self.kwargs = kwargs
        return _Response()


class _Emitter:
    def __init__(self):
        self.chunks = []
        self.initialized = False
        self.flushed = False

    def initialize(self, **kwargs):
        self.initialized = True
        self.kwargs = kwargs

    def push(self, chunk):
        self.chunks.append(chunk)

    def flush(self):
        self.flushed = True


@pytest.mark.asyncio
async def test_voxcpm2_streaming():
    tts = VoxCPM2TTS(
        endpoint="http://localhost:3000/api/tts/speech",
        voice="test-voice",
    )
    tts.http = _Session()

    stream = tts.synthesize("Hello world")
    emitter = _Emitter()
    await stream._run(emitter)

    assert emitter.initialized is True
    assert emitter.kwargs.get("sample_rate") == 48000
    assert len(emitter.chunks) == 2
    assert emitter.flushed is True


def test_voxcpm2_rejects_invalid_endpoint():
    with pytest.raises(ValueError, match="valid HTTP"):
        VoxCPM2TTS(endpoint="not-a-url")


def test_build_voxcpm2_tts_defaults():
    tts = build_voxcpm2_tts()
    assert tts.model == "voxcpm2"
    assert tts.provider == "voxcpm2"
    assert "api/tts/speech" in tts.endpoint or "v1/audio/speech" in tts.endpoint


class _ErrorResponse(_Response):
    def __init__(self, status: int, body: bytes):
        super().__init__()
        self.status = status
        self.body = body

    async def read(self):
        return self.body


class _ScriptedSession:
    """Answers each post with the next scripted response and records the voices asked for."""

    closed = False

    def __init__(self, *responses):
        self.responses = list(responses)
        self.voices: list[str] = []

    def post(self, endpoint, **kwargs):
        self.voices.append(kwargs["json"]["voice"])
        return self.responses.pop(0)


async def _speak(tts: VoxCPM2TTS, text: str) -> int:
    """Consume a synthesis the way the agent does; returns the number of audio frames."""
    frames = 0
    async with tts.synthesize(text) as stream:
        async for _ in stream:
            frames += 1
    return frames


def _tts(voice: str) -> VoxCPM2TTS:
    # max_retries=0: LiveKit's own retry would replay the scripted responses.
    return VoxCPM2TTS(endpoint="http://localhost:3000/api/tts/speech", voice=voice, fallback_voice="charlotte-sample", max_retries=0)


@pytest.mark.asyncio
async def test_unknown_voice_falls_back_and_keeps_speaking():
    tts = _tts("local-only-voice")
    tts.http = _ScriptedSession(_ErrorResponse(404, b'{"detail":"unknown voice: local-only-voice"}'), _Response(), _Response())
    assert await _speak(tts, "Hello") > 0
    # The next line goes straight to the fallback (no second failed lookup).
    assert await _speak(tts, "Again") > 0
    assert tts.http.voices == ["local-only-voice", "charlotte-sample", "charlotte-sample"]
    assert tts.voice == "charlotte-sample"


@pytest.mark.asyncio
async def test_other_errors_and_a_failing_fallback_still_raise():
    from livekit.agents import APIError

    tts = _tts("v1")
    tts.http = _ScriptedSession(_ErrorResponse(500, b"boom"))
    with pytest.raises(APIError):
        await _speak(tts, "Hello")
    assert tts.voice == "v1"  # not swapped for unrelated errors

    tts.http = _ScriptedSession(_ErrorResponse(404, b"unknown voice: v1"), _ErrorResponse(404, b"unknown voice: charlotte-sample"))
    with pytest.raises(APIError):
        await _speak(tts, "Hello")
    assert tts.http.voices == ["v1", "charlotte-sample"]  # no loop


@pytest.mark.asyncio
async def test_empty_voice_uses_the_fallback_not_default():
    tts = _tts("")
    tts.http = _ScriptedSession(_Response())
    assert await _speak(tts, "Hello") > 0
    assert tts.http.voices == ["charlotte-sample"]
