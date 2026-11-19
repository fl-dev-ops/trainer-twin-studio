import asyncio
import json
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

import agent


def context(metadata):
    room = SimpleNamespace(name="public-room", metadata="", remote_participants={"visitor": SimpleNamespace(identity="visitor-one")})
    callbacks = {}
    room.on = lambda name, callback: callbacks.update({name: callback})
    shutdown_callbacks = []
    return SimpleNamespace(
        job=SimpleNamespace(metadata=json.dumps(metadata), room=SimpleNamespace(metadata=""), id="job-public"),
        room=room,
        api=SimpleNamespace(room=SimpleNamespace(delete_room=AsyncMock())),
        connect=AsyncMock(),
        log_context_fields={},
        add_shutdown_callback=shutdown_callbacks.append,
        shutdown_callbacks=shutdown_callbacks,
        callbacks=callbacks,
    )


@pytest.mark.parametrize("deadline", [None, 0, -1, "future", True, float("nan"), float("inf")])
async def test_public_missing_or_invalid_deadline_never_connects(deadline):
    ctx = context({"anonymous": True, "runtimeToken": "secret", "ends_at": deadline})
    await agent.entrypoint(ctx)
    ctx.connect.assert_not_awaited()
    ctx.api.room.delete_room.assert_awaited_once()


async def test_public_expired_deadline_never_connects():
    ctx = context({"anonymous": True, "runtimeToken": "secret", "ends_at": time.time() - 1})
    await agent.entrypoint(ctx)
    ctx.connect.assert_not_awaited()
    ctx.api.room.delete_room.assert_awaited_once()


@pytest.mark.parametrize("startup_delay", [0, 0.08])
async def test_public_voice_only_forwarded_credentials_and_absolute_teardown(monkeypatch, startup_delay):
    monkeypatch.setenv("COPILOT_SERVICE_SECRET", "service-secret")
    monkeypatch.setenv("LLM_BASE_URL", "https://chat.example/v1")
    usage = SimpleNamespace(
        on_session_usage=lambda *_args: None, participants_changed=lambda *_args: None,
        start=lambda: None, close=AsyncMock(), add_llm_usage=lambda *_args: None,
    )
    monkeypatch.setattr(agent, "UsageReporter", lambda **_kwargs: usage)
    ctx = context({
        "anonymous": True, "sessionId": "visitor-session", "orgId": "org-one",
        "runtimeToken": "public-secret", "ends_at": time.time() + 0.04, "hold_opening": True,
    })
    captured = {}
    audio = []
    replies = []
    shutdown = []

    async def start(**kwargs):
        captured.update(kwargs)
        for payload in [
            {"type": "chat-message", "text": "Text must not reach brain"},
            {"type": "mcq-submission", "submitted": True, "questionId": "q1", "optionId": "a", "optionText": "A"},
            {"type": "code-submission", "submissionId": "s1", "questionId": "q1", "index": 0, "total": 1, "chunk": "secret"},
            {"type": "whiteboard-evaluation", "payload": "{}"},
            {"type": "screen-observer-note", "text": "private screen"},
        ]:
            ctx.callbacks["data_received"](SimpleNamespace(data=json.dumps(payload).encode()))
        await asyncio.sleep(startup_delay)

    session = SimpleNamespace(
        start=start, on=lambda *_args: lambda callback: callback,
        input=SimpleNamespace(set_audio_enabled=audio.append),
        generate_reply=AsyncMock(side_effect=lambda **kwargs: replies.append(kwargs)),
        shutdown=lambda **kwargs: shutdown.append(kwargs),
        history=SimpleNamespace(items=[
            SimpleNamespace(type="message", role="user", text_content="How do I handle objections?", metrics={}, created_at=1794994000),
            SimpleNamespace(type="message", role="assistant", text_content="Start with their concern.", metrics={}, created_at=1794994001),
        ]),
        usage=SimpleNamespace(),
    )

    def build(**kwargs):
        captured["llm"] = kwargs
        return session

    monkeypatch.setattr(agent, "build_agent_session", build)
    monkeypatch.setattr(agent, "ScreenFeedbackRuntime", lambda **_kwargs: pytest.fail("Public calls must never create screen feedback"))
    await agent.entrypoint(ctx)
    await asyncio.sleep(0.06)
    assert captured["llm"]["extra_headers"]["x-trainertwin-runtime-token"] == "public-secret"
    assert captured["llm"]["extra_headers"]["x-trainertwin-session-id"] == "visitor-session"
    assert captured["llm"]["extra_headers"]["Authorization"].startswith("Basic ")
    assert captured["room_options"].text_input is False
    assert captured["room_options"].video_input is False
    assert captured["session_host"] is False
    assert captured["agent"].hold_opening is False
    assert replies == []
    assert False in audio
    assert {"drain": False} in shutdown
    assert not captured["agent"].input_allowed()
    ctx.api.room.delete_room.assert_awaited_once()
    for callback in ctx.shutdown_callbacks:
        await callback()
    completion = AsyncMock()
    monkeypatch.setattr(agent, "post_completion_webhook", completion)
    await agent.on_session_end(ctx)
    payload = completion.await_args.args[1]
    assert payload["session_id"] == "visitor-session"
    assert payload["transcript"][0]["role"] == "user"
    assert payload["transcript"][1]["role"] == "trainer"
    assert ctx.room.name not in agent._sessions


@pytest.mark.parametrize("base_url", ["", "https://web.example/api/v1", "https://web.example/api/v1/?other=true"])
async def test_public_refuses_legacy_or_missing_chat_runtime(monkeypatch, base_url):
    monkeypatch.setenv("LLM_BASE_URL", base_url)
    monkeypatch.setenv("COPILOT_SERVICE_SECRET", "service-secret")
    ctx = context({"anonymous": True, "runtimeToken": "secret", "ends_at": time.time() + 60})
    await agent.entrypoint(ctx)
    ctx.connect.assert_not_awaited()
    ctx.api.room.delete_room.assert_awaited_once()
