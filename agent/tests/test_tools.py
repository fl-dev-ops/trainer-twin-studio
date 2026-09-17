from __future__ import annotations

from tools import build_interview_tools


class _FakeRoom:
    pass


def test_voice_transport_registers_no_workspace_tools():
    tools = build_interview_tools(room=_FakeRoom(), participant_identity="candidate-1")
    assert tools == []
