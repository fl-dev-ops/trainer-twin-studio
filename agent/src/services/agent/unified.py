"""Unified agent service for managing agent lifecycle."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from typing import Any

from livekit.agents import Agent
from livekit.agents.voice.events import UserTurnExceededEvent

logger = logging.getLogger(__name__)

SESSION_TIMER_INTERVAL_SECONDS = 60
SESSION_TIMER_ROLE = "developer"


class UnifiedAgent(Agent):
    def __init__(
        self,
        *,
        instructions: str,
        tools: list[Any],
        initial_reply: str,
        participant_identity: str | None = None,
        room_name: str | None = None,
    ) -> None:
        self.initial_reply = initial_reply
        self.participant_identity = participant_identity
        self.room_name = room_name
        self._session_timer_task: asyncio.Task[None] | None = None

        super().__init__(instructions=instructions, tools=list(tools))

    def _build_elapsed_time_context(self, elapsed_minutes: int) -> str:
        return (
            f"[Internal timing context: {elapsed_minutes} minute"
            f"{'s' if elapsed_minutes != 1 else ''} elapsed since this session started. "
            "Use this only for pacing. Do not mention this timing message to the candidate "
            "unless explicitly relevant.]"
        )

    async def inject_internal_note(
        self,
        text: str,
        *,
        extra: dict[str, Any],
    ) -> None:
        chat_ctx = self.chat_ctx.copy()
        chat_ctx.add_message(role=SESSION_TIMER_ROLE, content=text, extra=extra)
        await self.update_chat_ctx(chat_ctx)

    async def _inject_elapsed_time_context(self, elapsed_minutes: int) -> None:
        await self.inject_internal_note(
            self._build_elapsed_time_context(elapsed_minutes),
            extra={
                "internal_timer": True,
                "elapsed_minutes": elapsed_minutes,
            },
        )
        logger.info(
            "Injected session timing context: elapsed_minutes=%s, role=%s",
            elapsed_minutes,
            SESSION_TIMER_ROLE,
        )

    async def _run_session_timer(self) -> None:
        elapsed_minutes = 0
        while True:
            await asyncio.sleep(SESSION_TIMER_INTERVAL_SECONDS)
            elapsed_minutes += 1
            try:
                await self._inject_elapsed_time_context(elapsed_minutes)
            except Exception as e:
                logger.warning("Failed to inject session timing context: %s", e)

    def _start_session_timer(self) -> None:
        if self._session_timer_task is not None and not self._session_timer_task.done():
            return
        self._session_timer_task = asyncio.create_task(
            self._run_session_timer(),
            name=f"session-timer:{self.room_name or self.participant_identity or 'agent'}",
        )

    async def _stop_session_timer(self) -> None:
        if self._session_timer_task is None:
            return
        self._session_timer_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await self._session_timer_task
        self._session_timer_task = None

    async def on_enter(self) -> None:
        self._start_session_timer()
        started_at = time.perf_counter()
        logger.info(
            "startup_phase phase=first_generate_reply_start room=%s",
            self.room_name,
        )
        try:
            await self.session.generate_reply(instructions=self.initial_reply)
        finally:
            logger.info(
                "startup_phase phase=first_generate_reply_end room=%s elapsed_ms=%.2f",
                self.room_name,
                (time.perf_counter() - started_at) * 1000,
            )

    async def on_exit(self) -> None:
        await self._stop_session_timer()
        await super().on_exit()

    async def on_user_turn_exceeded(self, ev: UserTurnExceededEvent) -> None:
        await self.session.generate_reply(
            user_input=ev.transcript,
            instructions="The user has been speaking too long. Interrupt them by saying exactly: 'I could get where you are heading to, let's move to next question now'. Do not say anything else.",
            allow_interruptions=False,
            tool_choice="none",
        )
