"""Presentation workspace tools."""

from __future__ import annotations

import json
import logging
from typing import Any

from livekit.agents import RunContext, function_tool

logger = logging.getLogger(__name__)
PRESENTATION_RPC_METHOD = "workspace.presentation"


async def _call_presentation(
    room: Any,
    participant_identity: str,
    action: str,
    **payload: Any,
) -> dict[str, object]:
    response = await room.local_participant.perform_rpc(
        destination_identity=participant_identity,
        method=PRESENTATION_RPC_METHOD,
        payload=json.dumps({"action": action, "payload": payload}),
        response_timeout=15,
    )
    result = json.loads(response)
    if not isinstance(result, dict) or result.get("ok") is not True:
        raise RuntimeError(f"Presentation RPC failed: {result.get('error', 'unknown')}")
    return result


def build_presentation_tools(*, room: Any, participant_identity: str) -> list[Any]:
    @function_tool(
        name="get_presentation_state",
        description="Get current presentation slide number, total slides, and viewer state.",
    )
    async def get_presentation_state(context: RunContext) -> dict[str, object]:
        return await _call_presentation(room, participant_identity, "get_state")

    @function_tool(
        name="set_presentation_slide",
        description="Navigate to a specific slide in the presentation (0-indexed).",
    )
    async def set_presentation_slide(
        context: RunContext,
        slide_index: int,
    ) -> dict[str, object]:
        return await _call_presentation(
            room,
            participant_identity,
            "set_slide",
            index=slide_index,
        )

    @function_tool(
        name="next_presentation_slide",
        description="Advance to the next slide in the presentation.",
    )
    async def next_presentation_slide(context: RunContext) -> dict[str, object]:
        return await _call_presentation(room, participant_identity, "next_slide")

    @function_tool(
        name="previous_presentation_slide",
        description="Return to the previous slide in the presentation.",
    )
    async def previous_presentation_slide(context: RunContext) -> dict[str, object]:
        return await _call_presentation(room, participant_identity, "previous_slide")

    return [
        get_presentation_state,
        set_presentation_slide,
        next_presentation_slide,
        previous_presentation_slide,
    ]
