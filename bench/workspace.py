"""Virtual workspace executor for bench simulations.

Stands in for the LiveKit/browser tool executor: receives the brain's
transport tool calls, keeps simulated workspace state, and returns the
deterministic tool results the OpenAI tool-result contract expects.
No LiveKit, no browser, no DB.
"""

from __future__ import annotations

import time
from typing import Any
from uuid import uuid4

# Transport tools the virtual workspace can execute (must mirror the bridge's
# transport-tool set: chat/agent/channels/openai-compat.ts TRANSPORT_TOOLS).
EXECUTABLE_TOOLS = frozenset(
    {
        "surface",
        "finish_session",
        "workspace_request",
        "read_canvas_scene",
        "highlight_canvas_element",
        "add_canvas_component",
        "clear_canvas",
        "read_code_range",
        "highlight_code",
        "highlight_whiteboard",
        "get_code_state",
        "run_code",
        "get_presentation_state",
        "set_presentation_slide",
        "next_presentation_slide",
        "previous_presentation_slide",
    }
)

SURFACE_LABELS = {
    "pdf": "PDF document viewer",
    "canvas": "Whiteboard",
    "code": "Code editor",
    "image": "Image viewer",
    "presentation": "Presentation",
}


class VirtualWorkspace:
    """Simulated learner workspace with deterministic tool results."""

    def __init__(self) -> None:
        self.active_surface: str | None = None
        self.active_key: str | None = None
        self.session_ended = False
        self.history: list[dict] = []

    def execute(self, name: str, tool_input: dict | None) -> dict:
        """Execute one transport tool call and return its tool-result payload."""
        tool_input = tool_input if isinstance(tool_input, dict) else {}
        action = str(tool_input.get("action") or "")
        payload = tool_input.get("payload") if isinstance(tool_input.get("payload"), dict) else {}

        if name == "finish_session":
            self.session_ended = True
            result = {"status": "ok", "action": "finish_session"}
        elif name == "surface":
            result = self._surface(action, payload)
        elif name in EXECUTABLE_TOOLS:
            result = self._read_like(name, payload)
        else:
            result = {"status": "error", "error": f"unsupported tool: {name}"}

        self.history.append(
            {"tool": name, "input": tool_input, "result": result, "at": time.time()}
        )
        return result

    def _surface(self, action: str, payload: dict) -> dict:
        if action == "close_surface":
            self.active_surface = None
            self.active_key = None
            return {"status": "ok", "action": action}

        surface = {
            "open_pdf": "pdf",
            "highlight_document": "pdf",
            "open_whiteboard": "canvas",
            "open_code_editor": "code",
            "open_image": "image",
            "open_presentation": "presentation",
        }.get(action)
        if not surface:
            return {"status": "error", "error": f"unsupported surface action: {action}"}

        file_id = payload.get("fileId")
        if not isinstance(file_id, str) or not file_id:
            return {"status": "error", "error": f"{action} requires a fileId in payload"}

        self.active_surface = surface
        self.active_key = file_id
        return {
            "status": "ok",
            "action": action,
            "eventId": file_id,
            "surface": surface,
            "fileId": file_id,
            "highlightQuery": payload.get("highlightQuery") if isinstance(payload.get("highlightQuery"), str) else None,
        }

    def _read_like(self, name: str, payload: dict) -> dict:
        # ponytail: reads return deterministic empty/minimal scenes; enrich when
        # simulations need content-bearing canvas/editor fixtures.
        if name == "read_canvas_scene":
            elements = [] if self.active_surface != "canvas" else [{"id": "el-1", "label": ""}]
            return {"status": "ok", "elements": elements}
        if name == "read_code_range":
            return {"status": "ok", "code": ""}
        if name == "get_code_state":
            return {"status": "ok", "language": "python", "code": ""}
        if name == "get_presentation_state":
            return {"status": "ok", "slide": 1}
        if name == "run_code":
            return {"status": "ok", "stdout": "", "stderr": ""}
        if name.startswith("highlight_") or name in ("add_canvas_component", "clear_canvas", "set_presentation_slide"):
            if name == "highlight_canvas_element":
                element_id = payload.get("elementId") or payload.get("element_id")
                if not element_id:
                    return {"status": "error", "error": "highlight_canvas_element requires an element id"}
            return {"status": "ok", "action": name}
        if name == "workspace_request":
            return {"status": "ok", "action": payload.get("action")}
        if name == "next_presentation_slide":
            return {"status": "ok", "action": name, "slide": 2}
        if name == "previous_presentation_slide":
            return {"status": "ok", "action": name, "slide": 1}
        return {"status": "error", "error": f"unhandled tool: {name}"}

    def label(self) -> str:
        if not self.active_surface:
            return "none"
        label = SURFACE_LABELS.get(self.active_surface, self.active_surface)
        return f"{label} ({self.active_key})" if self.active_key else label


def new_event_id() -> str:
    return uuid4().hex
