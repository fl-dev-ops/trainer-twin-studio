from __future__ import annotations

import json
import logging
import time
from typing import Any

from livekit.agents import RunContext, function_tool

logger = logging.getLogger(__name__)
CODE_RPC_METHOD = "workspace.code"


async def _call(
    room: Any,
    participant_identity: str,
    action: str,
    **payload: object,
) -> dict[str, object]:
    started = time.monotonic()
    logger.info("[EXT-API:code-rpc] start action=%s", action)
    try:
        response = await room.local_participant.perform_rpc(
            destination_identity=participant_identity,
            method=CODE_RPC_METHOD,
            payload=json.dumps({"action": action, "payload": payload}),
            response_timeout=15,
        )
        result = json.loads(response)
        if not isinstance(result, dict) or result.get("ok") is not True:
            raise RuntimeError("Invalid code RPC response")
    except Exception as exc:
        logger.exception(
            "[EXT-API:code-rpc] failed action=%s elapsed_ms=%d error_type=%s",
            action,
            round((time.monotonic() - started) * 1000),
            type(exc).__name__,
        )
        raise
    logger.info(
        "[EXT-API:code-rpc] complete action=%s elapsed_ms=%d",
        action,
        round((time.monotonic() - started) * 1000),
    )
    return result


async def highlight_code_range(
    *,
    room: Any,
    participant_identity: str,
    from_line: int,
    to_line: int,
) -> dict[str, object]:
    return await _call(
        room,
        participant_identity,
        "highlight_range",
        fromLine=from_line,
        toLine=to_line,
    )


def build_code_highlight_tools(*, room: Any, participant_identity: str) -> list[Any]:
    @function_tool(
        name="read_code_range",
        description=(
            "Required before replying when a candidate is unsure, stuck, does not "
            "know, or requests help about an active Coding, Machine coding, or Code "
            "output editor. Read inclusive one-based lines 1 through 200 and never "
            "read the returned code aloud. Call highlight_code only when the candidate "
            "has written meaningful code and a specific line range is relevant."
        ),
    )
    async def read_code_range(
        context: RunContext,
        from_line: int,
        to_line: int,
    ) -> dict[str, object]:
        return await _call(
            room,
            participant_identity,
            "get_range",
            fromLine=from_line,
            toLine=to_line,
        )

    @function_tool(
        name="highlight_code",
        description=(
            "Use after read_code_range only when the candidate has written meaningful "
            "code and a specific line range is relevant. Highlight the smallest "
            "relevant inclusive one-based whole-line range without "
            "changing the code, then ask one targeted question that leads the "
            "candidate to the exact output or next implementation step."
        ),
    )
    async def highlight_code(
        context: RunContext,
        from_line: int,
        to_line: int,
    ) -> dict[str, object]:
        return await highlight_code_range(
            room=room,
            participant_identity=participant_identity,
            from_line=from_line,
            to_line=to_line,
        )

    return [read_code_range, highlight_code]
