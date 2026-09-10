"""Interview workspace and lifecycle tools."""

from __future__ import annotations

from typing import Any
from tools.canvas import build_canvas_tools
from tools.editor import build_editor_tools
from tools.presentation import build_presentation_tools
from tools.surface import build_surface_tools


def build_interview_tools(*, room: Any, participant_identity: str) -> list[Any]:
    tools: list[Any] = []
    tools.extend(build_surface_tools(room=room, participant_identity=participant_identity))
    tools.extend(build_editor_tools(room=room, participant_identity=participant_identity))
    tools.extend(build_canvas_tools(room=room, participant_identity=participant_identity))
    tools.extend(build_presentation_tools(room=room, participant_identity=participant_identity))
    return tools


__all__ = [
    "build_canvas_tools",
    "build_editor_tools",
    "build_interview_tools",
    "build_presentation_tools",
    "build_surface_tools",
]
