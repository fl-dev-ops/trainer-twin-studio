"""Code editor workspace tools."""

from __future__ import annotations

import json
import logging
from typing import Any

from livekit.agents import RunContext, function_tool

logger = logging.getLogger(__name__)
CODE_RPC_METHOD = "workspace.code"


async def _call_code(
    room: Any,
    participant_identity: str,
    action: str,
    **payload: Any,
) -> dict[str, object]:
    response = await room.local_participant.perform_rpc(
        destination_identity=participant_identity,
        method=CODE_RPC_METHOD,
        payload=json.dumps({"action": action, "payload": payload}),
        response_timeout=15,
    )
    result = json.loads(response)
    if not isinstance(result, dict) or result.get("ok") is not True:
        raise RuntimeError(f"Code RPC failed: {result.get('error', 'unknown')}")
    return result


def build_editor_tools(*, room: Any, participant_identity: str) -> list[Any]:
    @function_tool(
        name="read_code_range",
        description="Read lines from the active code editor. Provide 1-based from_line and to_line.",
    )
    async def read_code_range(
        context: RunContext,
        from_line: int,
        to_line: int,
    ) -> dict[str, object]:
        return await _call_code(
            room,
            participant_identity,
            "get_range",
            fromLine=from_line,
            toLine=to_line,
        )

    @function_tool(
        name="highlight_code",
        description="Highlight a line range in the candidate code editor without changing code.",
    )
    async def highlight_code(
        context: RunContext,
        from_line: int,
        to_line: int,
    ) -> dict[str, object]:
        return await _call_code(
            room,
            participant_identity,
            "highlight_range",
            fromLine=from_line,
            toLine=to_line,
        )

    @function_tool(
        name="get_code_state",
        description="Get the full code, active programming language, and cursor selection in the editor.",
    )
    async def get_code_state(context: RunContext) -> dict[str, object]:
        return await _call_code(room, participant_identity, "get_state")

    @function_tool(
        name="run_code",
        description="Execute the current code in the candidate editor and retrieve execution output.",
    )
    async def run_code(context: RunContext) -> dict[str, object]:
        return await _call_code(room, participant_identity, "run")

    return [read_code_range, highlight_code, get_code_state, run_code]
