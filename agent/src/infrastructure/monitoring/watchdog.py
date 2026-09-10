"""Idle room watchdog for automatic cleanup."""

from __future__ import annotations

import asyncio
import logging

from livekit import agents, rtc

logger = logging.getLogger(__name__)

IDLE_ROOM_TIMEOUT_SECONDS = 1 * 60
USER_PARTICIPANT_KINDS = frozenset(
    {
        rtc.ParticipantKind.PARTICIPANT_KIND_STANDARD,
        rtc.ParticipantKind.PARTICIPANT_KIND_SIP,
    }
)

_idle_room_watchdogs: dict[str, asyncio.Task[None]] = {}


def is_user_participant(participant: rtc.RemoteParticipant) -> bool:
    """Check if a participant is a user (not a bot)."""
    return participant.kind in USER_PARTICIPANT_KINDS


def room_has_user_participants(room: rtc.Room) -> bool:
    """Check if a room has any user participants."""
    return any(
        is_user_participant(participant)
        for participant in room.remote_participants.values()
    )


def cancel_idle_room_watchdog(room_name: str) -> None:
    """Cancel the idle room watchdog for a specific room."""
    watchdog = _idle_room_watchdogs.pop(room_name, None)
    if watchdog is not None:
        watchdog.cancel()


def sync_idle_room_watchdog(
    ctx: agents.JobContext,
    timeout_seconds: int = IDLE_ROOM_TIMEOUT_SECONDS,
) -> asyncio.Task[None] | None:
    """Synchronize the idle room watchdog state."""
    room_name = ctx.room.name
    if room_has_user_participants(ctx.room):
        cancel_idle_room_watchdog(room_name)
        return None

    existing = _idle_room_watchdogs.get(room_name)
    if existing is not None and not existing.done():
        return existing

    async def _watchdog() -> None:
        try:
            await asyncio.sleep(timeout_seconds)
            if room_has_user_participants(ctx.room):
                return

            logger.info(
                "Ending room after idle timeout with no STANDARD or SIP participants",
                extra={"room_name": room_name, "timeout_seconds": timeout_seconds},
            )
            await ctx.delete_room(room_name=room_name)
        except asyncio.CancelledError:
            raise
        finally:
            current = _idle_room_watchdogs.get(room_name)
            if current is asyncio.current_task():
                _idle_room_watchdogs.pop(room_name, None)

    watchdog = asyncio.create_task(_watchdog(), name=f"idle-room-watchdog:{room_name}")
    _idle_room_watchdogs[room_name] = watchdog
    return watchdog


def register_idle_room_watchdog(
    ctx: agents.JobContext,
    timeout_seconds: int = IDLE_ROOM_TIMEOUT_SECONDS,
) -> None:
    """Register event handlers for idle room watchdog."""

    @ctx.room.on("participant_connected")
    def _on_participant_connected(participant: rtc.RemoteParticipant) -> None:
        if is_user_participant(participant):
            cancel_idle_room_watchdog(ctx.room.name)

    @ctx.room.on("participant_disconnected")
    def _on_participant_disconnected(participant: rtc.RemoteParticipant) -> None:
        if is_user_participant(participant):
            sync_idle_room_watchdog(ctx, timeout_seconds)

    sync_idle_room_watchdog(ctx, timeout_seconds)
