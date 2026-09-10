from __future__ import annotations

import pytest
from interfaces.tts.voxcpm2 import VoxCPM2TTS, build_voxcpm2_tts


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
