"""TrainerTwin LiveKit Voice Agent Worker."""

from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any

from dotenv import load_dotenv
from livekit import agents, api, rtc
from livekit.agents import Agent, room_io
from livekit.plugins import noise_cancellation

from recording import post_completion_webhook, start_session_egress, stop_and_poll_egress
from session import build_agent_session
from tools import build_interview_tools

load_dotenv(override=True)

# Automatically trust local portless CA for https://*.localhost if present
portless_ca = os.path.expanduser("~/.portless/ca.pem")
if os.path.exists(portless_ca) and "SSL_CERT_FILE" not in os.environ:
    os.environ["SSL_CERT_FILE"] = portless_ca

logger = logging.getLogger("trainertwin_agent")
logging.basicConfig(level=logging.INFO)

AGENT_NAME = os.getenv("AGENT_NAME", "intervoo-agent")
WEB_URL = os.getenv("WEB_URL", "http://localhost:3000").rstrip("/")
_sessions: dict[str, dict[str, Any]] = {}


def parse_metadata(raw: str | None) -> dict[str, Any]:
    if not raw or not raw.strip():
        return {}
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


class TrainerAgent(Agent):
    """Interviewer agent that delegates conversation flow to TrainerTwin's web runtime."""

    def __init__(self, *, tools: list[Any], room_name: str) -> None:
        super().__init__(
            instructions="You are an expert interviewer. Drive the interview according to runtime guidance.",
            tools=tools,
        )
        self.room_name = room_name

    async def on_enter(self) -> None:
        logger.info("TrainerAgent entered room %s, requesting opening turn", self.room_name)
        try:
            await self.session.generate_reply(instructions="session-start")
        except Exception as exc:
            logger.exception("Failed to generate initial reply: %s", exc)


async def entrypoint(ctx: agents.JobContext) -> None:
    raw_meta = ctx.job.room.metadata or ctx.room.metadata or ctx.job.metadata
    metadata = parse_metadata(raw_meta)

    session_id = str(metadata.get("sessionId") or metadata.get("session_id") or ctx.room.name).strip()
    runtime_token = str(metadata.get("runtimeToken") or metadata.get("runtime_token") or "token-pending").strip()
    voice = str(metadata.get("voice") or "").strip()

    webhook_raw = str(metadata.get("webhook_url") or os.getenv("WEBHOOK_URL") or "").strip()
    if webhook_raw.startswith("/"):
        webhook_url = f"{WEB_URL}{webhook_raw}"
    elif webhook_raw:
        webhook_url = webhook_raw
    else:
        webhook_url = f"{WEB_URL}/api/sessions/webhook"

    await ctx.connect()
    logger.info("Agent connected to room %s for session %s", ctx.room.name, session_id)

    participant_identity: str | None = None
    for _ in range(60):
        for p in ctx.room.remote_participants.values():
            participant_identity = p.identity
            break
        if participant_identity:
            break
        await asyncio.sleep(0.5)

    if not participant_identity:
        participant_identity = f"candidate-{session_id}"

    # Start optional S3 recording egress
    egress_data = await start_session_egress(lk_api=ctx.api, room_name=ctx.room.name)

    _sessions[ctx.room.name] = {
        "session_id": session_id,
        "runtime_token": runtime_token,
        "webhook_url": webhook_url,
        "participant_identity": participant_identity,
        "audio_egress_id": egress_data.get("audio_egress_id"),
        "video_egress_id": egress_data.get("video_egress_id"),
        "audio_url": egress_data.get("audio_url"),
        "video_url": egress_data.get("video_url"),
        "audio_s3_key": egress_data.get("audio_s3_key"),
        "video_s3_key": egress_data.get("video_s3_key"),
    }

    tools = build_interview_tools(room=ctx.room, participant_identity=participant_identity)
    session = build_agent_session(
        base_url=f"{WEB_URL}/api/v1",
        api_key=runtime_token,
        voice=voice,
    )

    agent = TrainerAgent(tools=tools, room_name=ctx.room.name)

    await session.start(
        room=ctx.room,
        agent=agent,
        room_options=room_io.RoomOptions(
            audio_input=room_io.AudioInputOptions(
                noise_cancellation=noise_cancellation.BVC(),
            ),
            close_on_disconnect=False,
        ),
    )


async def on_session_end(ctx: agents.JobContext) -> None:
    logger.info("Session ending for room %s", ctx.room.name)
    state = _sessions.pop(ctx.room.name, None) or {}

    audio_egress_id = state.get("audio_egress_id")
    video_egress_id = state.get("video_egress_id")

    if audio_egress_id:
        await stop_and_poll_egress(ctx.api, audio_egress_id)
    if video_egress_id:
        await stop_and_poll_egress(ctx.api, video_egress_id)

    webhook_url = state.get("webhook_url") or f"{WEB_URL}/api/sessions/webhook"
    payload = {
        "session_id": state.get("session_id") or ctx.room.name,
        "room_name": ctx.room.name,
        "audio_url": state.get("audio_url"),
        "audio_s3_key": state.get("audio_s3_key"),
        "video_url": state.get("video_url"),
        "video_s3_key": state.get("video_s3_key"),
        "status": "COMPLETED",
        "participant_identity": state.get("participant_identity"),
    }

    await post_completion_webhook(webhook_url, payload)

    try:
        await ctx.api.room.delete_room(api.DeleteRoomRequest(room=ctx.room.name))
        logger.info("Room %s gracefully destroyed", ctx.room.name)
    except Exception as exc:
        logger.debug("Room deletion note: %s", exc)


server = agents.AgentServer()
server.rtc_session(agent_name=AGENT_NAME, on_session_end=on_session_end)(entrypoint)


def main() -> None:
    agents.cli.run_app(server)


if __name__ == "__main__":
    main()
