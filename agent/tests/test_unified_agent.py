from __future__ import annotations

import pytest

from services.agent.unified import SESSION_TIMER_ROLE, UnifiedAgent


@pytest.mark.asyncio
async def test_elapsed_time_context_is_added_as_developer_message() -> None:
    agent = UnifiedAgent(
        instructions="You are a test agent.",
        tools=[],
        initial_reply="Hello.",
    )

    await agent._inject_elapsed_time_context(2)

    messages = agent.chat_ctx.messages()
    assert len(messages) == 1
    assert messages[0].role == SESSION_TIMER_ROLE
    assert messages[0].extra == {
        "internal_timer": True,
        "elapsed_minutes": 2,
    }
    assert "2 minutes elapsed" in (messages[0].text_content or "")
    assert "Do not mention this timing message" in (messages[0].text_content or "")
