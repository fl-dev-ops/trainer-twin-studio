"""Whiteboard (system design) workspace tools — same tool calls as the reference interview agent."""

from __future__ import annotations

import json
import logging
import time
from typing import Any

from livekit.agents import RunContext, function_tool

logger = logging.getLogger(__name__)
WHITEBOARD_RPC_METHOD = "workspace.whiteboard"


def build_whiteboard_tools(*, room: Any, participant_identity: str) -> list[Any]:
    @function_tool(
        name="highlight_whiteboard",
        description=(
            "Highlight one exact visible component label on the candidate's whiteboard, "
            "then ask one targeted follow-up about that component's responsibility, "
            "connection, bottleneck, failure mode, scale, or trade-off. The label must "
            "match text the candidate actually wrote on the whiteboard; never invent a "
            "label."
        ),
    )
    async def highlight_whiteboard(
        context: RunContext,
        component_label: str,
    ) -> dict[str, object]:
        started = time.monotonic()
        logger.info("[EXT-API:whiteboard-rpc] start action=highlight_component")
        try:
            response = await room.local_participant.perform_rpc(
                destination_identity=participant_identity,
                method=WHITEBOARD_RPC_METHOD,
                payload=json.dumps(
                    {
                        "action": "highlight_component",
                        "payload": {"componentLabel": component_label},
                    }
                ),
                response_timeout=15,
            )
            result = json.loads(response)
            if not isinstance(result, dict) or result.get("ok") is not True:
                raise RuntimeError("Whiteboard component was not found")
        except Exception as exc:
            logger.exception(
                "[EXT-API:whiteboard-rpc] failed action=highlight_component "
                "elapsed_ms=%d error_type=%s",
                round((time.monotonic() - started) * 1000),
                type(exc).__name__,
            )
            raise
        logger.info(
            "[EXT-API:whiteboard-rpc] complete action=highlight_component elapsed_ms=%d",
            round((time.monotonic() - started) * 1000),
        )
        return result

    return [highlight_whiteboard]
