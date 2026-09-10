from __future__ import annotations

import json
import logging
import time
from collections.abc import Awaitable, Callable
from typing import Any

from livekit.agents import RunContext, function_tool

logger = logging.getLogger(__name__)
WHITEBOARD_RPC_METHOD = "workspace.whiteboard"
AssessmentReader = Callable[[], Awaitable[dict[str, Any] | None]]


def build_whiteboard_highlight_tools(
    *,
    room: Any,
    participant_identity: str,
    read_assessment: AssessmentReader,
) -> list[Any]:
    @function_tool(
        name="read_whiteboard_assessment",
        description=(
            "Required after a submitted System design or Whiteboard answer and its "
            "spoken walkthrough, and again after the candidate answers the first "
            "follow-up. Read the verified visible components, connections, strengths, "
            "gaps, and unclear areas before each of the two required follow-ups."
        ),
    )
    async def read_whiteboard_assessment(
        context: RunContext,
    ) -> dict[str, object]:
        assessment = await read_assessment()
        if assessment is None:
            return {
                "status": "unavailable",
                "message": "No accepted visual assessment is available yet.",
            }
        return {"status": "ok", "assessment": assessment}

    @function_tool(
        name="highlight_whiteboard",
        description=(
            "Required after read_whiteboard_assessment. Pass one exact visible "
            "component label from the assessment. Focus and highlight that labeled "
            "component, then ask one targeted response-grounded follow-up about its "
            "responsibility, connection, bottleneck, failure mode, scale, or trade-off. "
            "Use this sequence for both required follow-ups, waiting for the candidate's "
            "answer before starting the second."
        ),
    )
    async def highlight_whiteboard(
        context: RunContext,
        component_label: str,
    ) -> dict[str, object]:
        started = time.monotonic()
        logger.info(
            "[EXT-API:whiteboard-rpc] start action=highlight_component"
        )
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

    return [read_whiteboard_assessment, highlight_whiteboard]
