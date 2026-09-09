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
