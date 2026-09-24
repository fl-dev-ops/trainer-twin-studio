from __future__ import annotations

import asyncio
import json
import logging
from types import SimpleNamespace

import pytest

import agent


def test_validate_environment_exits_with_missing_vars(monkeypatch, capsys):
    for key in agent.REQUIRED_ENV_VARS:
        monkeypatch.delenv(key, raising=False)
    monkeypatch.delenv("AWS_S3_BUCKET", raising=False)
    monkeypatch.delenv("S3_BUCKET", raising=False)

    with pytest.raises(SystemExit) as exc:
        agent.validate_environment()

    assert exc.value.code == 1
    err = capsys.readouterr().err
    assert "LIVEKIT_URL" in err and "SARVAM_API_KEY" in err
    assert "AWS_S3_BUCKET/S3_BUCKET" in err


def test_validate_environment_passes_with_all_vars(monkeypatch):
    for key in agent.REQUIRED_ENV_VARS:
        monkeypatch.setenv(key, "x")
    monkeypatch.setenv("AWS_S3_BUCKET", "bucket")
    agent.validate_environment()  # must not raise SystemExit


async def test_inactivity_nudge_only_runs_after_opening():
    class Session:
        callback = None
        replies: list[str] = []

        def on(self, _event):
            def register(callback):
                self.callback = callback
                return callback
            return register

        async def generate_reply(self, *, instructions):
            self.replies.append(instructions)

    session = Session()
    trainer = SimpleNamespace(opening_complete=False, room_name="room-1")
    agent.register_inactivity_nudge(session, trainer)

    session.callback(SimpleNamespace(new_state="away"))
    await asyncio.sleep(0)
    assert session.replies == []

    trainer.opening_complete = True
    session.callback(SimpleNamespace(new_state="listening"))
    session.callback(SimpleNamespace(new_state="away"))
    await asyncio.sleep(0)
    assert session.replies == [agent.USER_INACTIVE_SIGNAL]


def test_latency_logging_emits_structured_turn_metrics(caplog):
    class Session:
        def __init__(self):
            self.callbacks = {}

        def on(self, event):
            def register(callback):
                self.callbacks[event] = callback
                return callback
            return register

    session = Session()
    agent.register_latency_logging(session, session_id="s1", room_name="room-1")

    with caplog.at_level(logging.INFO, logger="trainertwin_agent"):
        session.callbacks["conversation_item_added"](
            SimpleNamespace(
                item=SimpleNamespace(
                    type="message",
                    id="user-1",
                    role="user",
                    metrics={
                        "transcription_delay": 0.12,
                        "end_of_turn_delay": 0.65,
                        "stt_metadata": {"model_provider": "deepgram", "model_name": "flux-general-en"},
                    },
                )
            )
        )
        session.callbacks["conversation_item_added"](
            SimpleNamespace(
                item=SimpleNamespace(
                    type="message",
                    id="assistant-1",
                    role="assistant",
                    metrics={
                        "llm_node_ttft": 1.25,
                        "tts_node_ttfb": 0.18,
                        "playback_latency": 0.03,
                        "e2e_latency": 2.23,
                        "llm_metadata": {"model_provider": "groq", "model_name": "gpt-oss-120b"},
                        "tts_metadata": {"model_provider": "sarvam", "model_name": "bulbul:v3"},
                    },
                )
            )
        )

    records = [record.message for record in caplog.records if record.message.startswith("[voice-latency]")]
    assert len(records) == 2
    user = json.loads(records[0].removeprefix("[voice-latency] "))
    assistant = json.loads(records[1].removeprefix("[voice-latency] "))
    assert user == {
        "sessionId": "s1",
        "roomName": "room-1",
        "turnIndex": 1,
        "messageId": "user-1",
        "role": "user",
        "transcriptionDelayMs": 120.0,
        "endOfTurnDelayMs": 650.0,
        "sttProvider": "deepgram",
        "sttModel": "flux-general-en",
    }
    assert assistant["turnIndex"] == 1
    assert assistant["llmTtftMs"] == 1250.0
    assert assistant["ttsTtfbMs"] == 180.0
    assert assistant["playbackLatencyMs"] == 30.0
    assert assistant["e2eLatencyMs"] == 2230.0
    assert assistant["llmProvider"] == "groq"
    assert assistant["ttsProvider"] == "sarvam"


def test_on_session_end_sends_transcript(monkeypatch):
    class Item:
        type = "message"
        role = "assistant"
        text_content = "Tell me about a project.  "

    class History:
        items = [Item()]

    class Session:
        history = History()

    class Ctx:
        class room:
            name = "session-s1"
        api = None

    agent._sessions["session-s1"] = {"session": Session(), "webhook_url": "http://x", "session_id": "s1"}
    sent = {}

    async def fake_post(url, payload):
        sent.update(payload)

    monkeypatch.setattr(agent, "post_completion_webhook", fake_post)
    # leave an event loop installed — closing it would break tests that use asyncio.get_event_loop
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    loop.run_until_complete(agent.on_session_end(Ctx()))
    assert sent["transcript"] == [{"role": "trainer", "text": "Tell me about a project."}]
