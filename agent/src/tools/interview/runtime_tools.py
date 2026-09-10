"""Runtime tools expected by TrainerTwin web runtime (/api/v1/chat/completions)."""

from __future__ import annotations

import json
import logging
import uuid
from typing import Any

from livekit.agents import RunContext, function_tool

logger = logging.getLogger(__name__)


def build_runtime_tools(*, room: Any, participant_identity: str) -> list[Any]:
    """Tools invoked by TrainerTwin's spec-driven runtime (/api/v1/chat/completions)."""

    @function_tool(
        name="surface",
        description="Open or close an interview workspace surface (e.g., code editor, whiteboard, pdf, presentation).",
    )
    async def surface(
        context: RunContext,
        action: str,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, object]:
        actual_payload = payload or {}
        event_id = uuid.uuid4().hex
        logger.info("surface tool invoked: action=%s event_id=%s", action, event_id)
        msg = {
            "type": action,
            "action": action,
            "eventId": event_id,
            "payload": actual_payload,
            **actual_payload,
        }
        await room.local_participant.publish_data(
            json.dumps(msg).encode("utf-8"),
            reliable=True,
        )
        return {"status": "ok", "action": action}

    @function_tool(
        name="finish_session",
        description="Signals the interview conclusion.",
    )
    async def finish_session(context: RunContext) -> dict[str, object]:
        logger.info("finish_session tool invoked by web runtime")
        await room.local_participant.publish_data(
            json.dumps({"type": "session-ended", "status": "completed"}).encode("utf-8"),
            reliable=True,
        )
        return {"status": "completed"}

    @function_tool(
        name="workspace_request",
        description="Request an action or state from the browser workspace over RPC.",
    )
    async def workspace_request(
        context: RunContext,
        method: str,
        action: str,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, object]:
        logger.info("workspace_request tool invoked: method=%s action=%s", method, action)
        try:
            response = await room.local_participant.perform_rpc(
                destination_identity=participant_identity,
                method=method,
                payload=json.dumps({"action": action, "payload": payload or {}}),
                response_timeout=15,
            )
            result = json.loads(response)
            return {"status": "ok", "result": result}
        except Exception as e:
            logger.exception("workspace_request failed: %s", e)
            return {"status": "error", "error": str(e)}

    return [surface, finish_session, workspace_request]
