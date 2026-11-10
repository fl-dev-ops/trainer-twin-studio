from __future__ import annotations

from session import build_agent_session
from tts import build_tts


def test_build_agent_session_configuration():
    session = build_agent_session(
        base_url="http://localhost:3000/api/v1",
        api_key="dynamic-runtime-token",
        model="trainertwin-brain",
        voice="test-voice",
    )

    assert session.llm._client.base_url == "http://localhost:3000/api/v1/"
    assert session.llm._client.api_key == "dynamic-runtime-token"
    assert session.llm._opts.model == "trainertwin-brain"
    assert session.options.user_away_timeout == 60.0

    opts = session.options.turn_handling
    assert opts["preemptive_generation"]["enabled"] is False
    assert opts["endpointing"]["mode"] == "dynamic"
    assert opts["endpointing"]["min_delay"] == 0.6
    assert opts["endpointing"]["max_delay"] == 1.2
    assert opts["interruption"]["mode"] == "adaptive"
    assert opts["interruption"]["min_words"] == 2
    assert opts["interruption"]["resume_false_interruption"] is True


def test_build_tts_is_voxcpm2(monkeypatch):
    monkeypatch.setenv("TTS_SERVICE_URL", "https://tts.example/v1/audio/speech")
    wrapped = build_tts(voice="cloned-voice")
    assert wrapped._wrapped_tts.voice == "cloned-voice"
    assert wrapped._wrapped_tts.model_label == "voxcpm2"
