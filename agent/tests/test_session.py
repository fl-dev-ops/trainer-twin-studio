from __future__ import annotations

from session import build_agent_session
from tts import build_tts


def test_build_agent_session_configuration():
    session = build_agent_session(
        base_url="http://localhost:3000/api/v1",
        api_key="dynamic-runtime-token",
        model="trainertwin-runtime",
        voice="test-voice",
    )

    assert session.llm._client.base_url == "http://localhost:3000/api/v1/"
    assert session.llm._client.api_key == "dynamic-runtime-token"
    assert session.llm._opts.model == "trainertwin-runtime"

    opts = session.options.turn_handling
    assert opts["preemptive_generation"]["enabled"] is False
    assert opts["endpointing"]["mode"] == "dynamic"
    assert opts["endpointing"]["min_delay"] == 0.6
    assert opts["endpointing"]["max_delay"] == 2.0
    assert opts["interruption"]["mode"] == "adaptive"
    assert opts["interruption"]["min_words"] == 2
    assert opts["interruption"]["resume_false_interruption"] is True


def test_sarvam_uses_its_own_speaker(monkeypatch):
    monkeypatch.setenv("TTS_PROVIDER", "sarvam")
    monkeypatch.setenv("SARVAM_API_KEY", "test-key")
    monkeypatch.setenv("SARVAM_SPEAKER", "rohan")

    tts = build_tts(voice="voxcpm-cloned-voice-id")

    assert tts._opts.speaker == "rohan"
