from __future__ import annotations

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


def test_on_session_end_sends_transcript(monkeypatch):
    import asyncio

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
