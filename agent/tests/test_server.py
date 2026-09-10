from __future__ import annotations

import asyncio

import pytest

from app.config import CALLER_LOOKUP_TIMEOUT_SECONDS
from app.server import server
from app.session import resolve_call_state


def test_agent_server_memory_thresholds_are_configured() -> None:
    assert server._job_memory_warn_mb == 2048
    assert server._job_memory_limit_mb == 4096


@pytest.mark.asyncio
async def test_resolve_call_state_waits_five_minutes_before_timing_out(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured_timeout = None

    async def fake_wait_for(coro, timeout):
        nonlocal captured_timeout
        captured_timeout = timeout
        coro.close()
        raise asyncio.TimeoutError

    class FakeRoom:
        def __init__(self) -> None:
            self.name = "empty-room"
            self.remote_participants = {}

    class FakeContext:
        def __init__(self) -> None:
            self.room = FakeRoom()

        async def wait_for_participant(self):
            return None

    monkeypatch.setattr("app.session.asyncio.wait_for", fake_wait_for)

    resolved_user_id, participant_identity, phone_number, attributes = (
        await resolve_call_state(FakeContext(), "user-123")
    )

    assert captured_timeout == CALLER_LOOKUP_TIMEOUT_SECONDS == 300
    assert resolved_user_id == "user-123"
    assert participant_identity is None
    assert phone_number is None
    assert attributes is None
