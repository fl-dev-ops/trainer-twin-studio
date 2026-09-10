"""Canvas and whiteboard workspace tools."""

from __future__ import annotations

import json
import logging
from typing import Any

from livekit.agents import RunContext, function_tool

logger = logging.getLogger(__name__)
CANVAS_RPC_METHOD = "workspace.canvas"


async def _call_canvas(
    room: Any,
    participant_identity: str,
    action: str,
    **payload: Any,
) -> dict[str, object]:
    response = await room.local_participant.perform_rpc(
        destination_identity=participant_identity,
        method=CANVAS_RPC_METHOD,
        payload=json.dumps({"action": action, "payload": payload}),
        response_timeout=15,
    )
    result = json.loads(response)
    if not isinstance(result, dict) or result.get("ok") is not True:
        raise RuntimeError(f"Canvas RPC failed: {result.get('error', 'unknown')}")
    return result


def build_canvas_tools(*, room: Any, participant_identity: str) -> list[Any]:
    @function_tool(
        name="read_canvas_scene",
        description="Retrieve all elements and diagrams currently drawn on the whiteboard canvas.",
    )
    async def read_canvas_scene(context: RunContext) -> dict[str, object]:
        return await _call_canvas(room, participant_identity, "get_scene")

    @function_tool(
        name="highlight_canvas_element",
        description="Highlight and scroll to a specific component element on the whiteboard canvas by ID.",
    )
    async def highlight_canvas_element(
        context: RunContext,
        element_id: str,
    ) -> dict[str, object]:
        return await _call_canvas(
            room,
            participant_identity,
            "highlight_elements",
            ids=[element_id],
        )

    @function_tool(
        name="add_canvas_component",
        description="Add a system architecture component box with a label to the whiteboard canvas.",
    )
    async def add_canvas_component(
        context: RunContext,
        label: str,
        x: int = 100,
        y: int = 100,
    ) -> dict[str, object]:
        return await _call_canvas(
            room,
            participant_identity,
            "add_system_component",
            label=label,
            x=x,
            y=y,
        )

    @function_tool(
        name="clear_canvas",
        description="Clear all elements from the whiteboard canvas.",
    )
    async def clear_canvas(context: RunContext) -> dict[str, object]:
        return await _call_canvas(room, participant_identity, "clear")

    return [
        read_canvas_scene,
        highlight_canvas_element,
        add_canvas_component,
        clear_canvas,
    ]
