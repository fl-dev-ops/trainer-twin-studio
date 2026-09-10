"""Surface and session lifecycle tools."""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from typing import Any

from livekit.agents import RunContext, function_tool, get_job_context

logger = logging.getLogger(__name__)


def build_surface_tools(*, room: Any, participant_identity: str) -> list[Any]:
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
        logger.info("surface action=%s event_id=%s", action, event_id)
        msg = {
            "type": action,
            "action": action,
            "eventId": event_id,
            "payload": actual_payload,
            **actual_payload,
        }
        try:
            await room.local_participant.perform_rpc(
                destination_identity=participant_identity,
                method="workspace.surface",
                payload=json.dumps(msg),
                response_timeout=15,
            )
        except Exception as exc:
            logger.warning("surface RPC fallback to data packet: %s", exc)
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
        logger.info("finish_session invoked by web runtime")

        async def _graceful_teardown():
            try:
                await asyncio.sleep(1.5)
                await context.session.wait_for_idle()
            except Exception:
                await asyncio.sleep(4.0)

            try:
                await room.local_participant.perform_rpc(
                    destination_identity=participant_identity,
                    method="session.end",
                    payload=json.dumps({"status": "completed"}),
                    response_timeout=5,
                )
            except Exception:
                try:
                    await room.local_participant.publish_data(
                        json.dumps({"type": "session-ended", "status": "completed"}).encode("utf-8"),
                        reliable=True,
                    )
                except Exception:
                    pass

            await asyncio.sleep(1.0)
            job_ctx = get_job_context(required=False)
            if job_ctx:
                job_ctx.shutdown(reason="interview_completed")

        asyncio.create_task(_graceful_teardown())
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
        logger.info("workspace_request method=%s action=%s", method, action)
        try:
            response = await room.local_participant.perform_rpc(
                destination_identity=participant_identity,
                method=method,
                payload=json.dumps({"action": action, "payload": payload or {}}),
                response_timeout=15,
            )
            return json.loads(response)
        except Exception as exc:
            logger.exception("workspace_request failed: %s", exc)
            return {"status": "error", "error": str(exc)}

    return [surface, finish_session, workspace_request]
