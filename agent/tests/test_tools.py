from __future__ import annotations

import json
import pytest
from unittest.mock import AsyncMock, MagicMock
from tools import build_interview_tools


class _FakeParticipant:
    def __init__(self):
        self.perform_rpc = AsyncMock(return_value=json.dumps({"ok": True}))
        self.publish_data = AsyncMock()


class _FakeRoom:
    def __init__(self):
        self.local_participant = _FakeParticipant()


def test_build_interview_tools_registers_all_categories():
    room = _FakeRoom()
    tools = build_interview_tools(room=room, participant_identity="candidate-1")

    tool_names = [t.info.name for t in tools]
    # Surface tools
    assert "surface" in tool_names
    assert "finish_session" in tool_names
    assert "workspace_request" in tool_names

    # Editor tools
    assert "read_code_range" in tool_names
    assert "highlight_code" in tool_names
    assert "get_code_state" in tool_names
    assert "run_code" in tool_names

    # Canvas tools
    assert "read_canvas_scene" in tool_names
    assert "highlight_canvas_element" in tool_names
    assert "add_canvas_component" in tool_names
    assert "clear_canvas" in tool_names

    # Presentation tools
    assert "get_presentation_state" in tool_names
    assert "set_presentation_slide" in tool_names
    assert "next_presentation_slide" in tool_names
    assert "previous_presentation_slide" in tool_names


@pytest.mark.asyncio
async def test_editor_tool_calls_code_rpc():
    room = _FakeRoom()
    tools = {t.info.name: t for t in build_interview_tools(room=room, participant_identity="candidate-1")}

    read_tool = tools["read_code_range"]
    context = MagicMock()
    result = await read_tool(context, from_line=1, to_line=10)

    assert result == {"ok": True}
    room.local_participant.perform_rpc.assert_called_once()
    call_args = room.local_participant.perform_rpc.call_args[1]
    assert call_args["method"] == "workspace.code"
    payload = json.loads(call_args["payload"])
    assert payload["action"] == "get_range"
    assert payload["payload"]["fromLine"] == 1
    assert payload["payload"]["toLine"] == 10
