"""Session helpers: PTT/Auto mode, participant resolution, room options."""

from __future__ import annotations

import asyncio
import logging

from livekit import agents, rtc
from livekit.agents import AgentSession, RecordingOptions, room_io
from livekit.plugins import noise_cancellation

from services.agent.unified import UnifiedAgent
from services.identity.resolver import (
    resolve_phone_number_from_call_context,
    resolve_user_id_from_call_context,
)

logger = logging.getLogger("intervoo_agent")

CALLER_LOOKUP_TIMEOUT_SECONDS = 300


def build_room_options() -> room_io.RoomOptions:
    return room_io.RoomOptions(
        audio_input=room_io.AudioInputOptions(
            noise_cancellation=lambda params: (
                noise_cancellation.BVCTelephony()
                if params.participant.kind == rtc.ParticipantKind.PARTICIPANT_KIND_SIP
                else noise_cancellation.BVC()
            ),
        ),
        close_on_disconnect=False,
    )


def register_push_to_talk_rpcs(
    ctx: agents.JobContext,
    session: AgentSession,
) -> None:
    @ctx.room.local_participant.register_rpc_method("start_turn")
    async def start_turn(data: rtc.RpcInvocationData) -> str:
        logger.info(f"start_turn RPC called by {data.caller_identity}")
        session.interrupt()
        session.clear_user_turn()
        if getattr(session, "room_io", None) is not None:
            session.room_io.set_participant(data.caller_identity)
        session.input.set_audio_enabled(True)
        return "ok"

    @ctx.room.local_participant.register_rpc_method("end_turn")
    async def end_turn(data: rtc.RpcInvocationData) -> str:
        logger.info(f"end_turn RPC called by {data.caller_identity}")
        session.input.set_audio_enabled(False)
        session.commit_user_turn(
            transcript_timeout=3.0,
            stt_flush_duration=0.5,
        )
        return "ok"

    @ctx.room.local_participant.register_rpc_method("cancel_turn")
    async def cancel_turn(data: rtc.RpcInvocationData) -> str:
        logger.info(f"cancel_turn RPC called by {data.caller_identity}")
        session.input.set_audio_enabled(False)
        session.clear_user_turn()
        return "ok"

    @ctx.room.local_participant.register_rpc_method("pause_session")
    async def pause_session(data: rtc.RpcInvocationData) -> str:
        logger.info(f"pause_session RPC called by {data.caller_identity}")
        session.interrupt()
        session.input.set_audio_enabled(False)
        return "ok"

    @ctx.room.local_participant.register_rpc_method("resume_session")
    async def resume_session(data: rtc.RpcInvocationData) -> str:
        logger.info(f"resume_session RPC called by {data.caller_identity}")
        session.input.set_audio_enabled(True)
        return "ok"


async def start_auto_session(
    ctx: agents.JobContext,
    session: AgentSession,
    agent: UnifiedAgent,
    *,
    recording_options: RecordingOptions | None = None,
) -> None:
    if recording_options is None:
        await session.start(
            room=ctx.room,
            agent=agent,
            room_options=build_room_options(),
        )
    else:
        await session.start(
            room=ctx.room,
            agent=agent,
            room_options=build_room_options(),
            record=recording_options,
        )
    logger.info("Unified agent auto session started")


async def start_ptt_session(
    ctx: agents.JobContext,
    session: AgentSession,
    agent: UnifiedAgent,
    *,
    recording_options: RecordingOptions | None = None,
) -> None:
    if recording_options is None:
        await session.start(
            room=ctx.room,
            agent=agent,
            room_options=build_room_options(),
        )
    else:
        await session.start(
            room=ctx.room,
            agent=agent,
            room_options=build_room_options(),
            record=recording_options,
        )
    session.input.set_audio_enabled(False)
    register_push_to_talk_rpcs(ctx, session)
    logger.info("Unified agent PTT session started")


def pick_call_participant(ctx: agents.JobContext) -> rtc.RemoteParticipant | None:
    participants = list(ctx.room.remote_participants.values())
    for participant in participants:
        if participant.kind == rtc.ParticipantKind.PARTICIPANT_KIND_SIP:
            return participant
    return participants[0] if participants else None


async def resolve_call_state(
    ctx: agents.JobContext,
    initial_user_id: str,
) -> tuple[str, str | None, str | None, dict[str, str] | None]:
    participant = pick_call_participant(ctx)
    if participant is None:
        try:
            participant = await asyncio.wait_for(
                ctx.wait_for_participant(),
                timeout=CALLER_LOOKUP_TIMEOUT_SECONDS,
            )
        except asyncio.TimeoutError:
            participant = None

    participant_identity = participant.identity if participant else None
    participant_attributes = (
        dict(participant.attributes.items())
        if participant and participant.attributes
        else None
    )
    resolved_user_id = resolve_user_id_from_call_context(
        current_user_id=initial_user_id,
        participant_identity=participant_identity,
        participant_attributes=participant_attributes,
        room_name=ctx.room.name,
    )
    phone_number = resolve_phone_number_from_call_context(
        participant_identity=participant_identity,
        participant_attributes=participant_attributes,
        room_name=ctx.room.name,
    )
    return resolved_user_id, participant_identity, phone_number, participant_attributes
