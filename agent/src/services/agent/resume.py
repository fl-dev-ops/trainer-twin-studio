"""Resume-only agent with fixed opening speech and tool-only model output."""

from __future__ import annotations

import logging
import time
from collections.abc import AsyncIterable, AsyncIterator
from typing import Any

from livekit.agents import llm
from livekit.agents.voice.agent import ModelSettings
from livekit.agents.voice.events import UserTurnExceededEvent

from services.agent.unified import UnifiedAgent

logger = logging.getLogger(__name__)


async def tool_only_chunks(chunks: AsyncIterable[Any]) -> AsyncIterator[Any]:
    """Strip model text while preserving tool calls, usage, and flush sentinels."""

    suppressed = 0
    async for chunk in chunks:
        if isinstance(chunk, str):
            suppressed += bool(chunk)
            continue
        if isinstance(chunk, llm.ChatChunk) and chunk.delta is not None:
            if chunk.delta.content:
                suppressed += 1
                delta = chunk.delta.model_copy(update={"content": None})
                chunk = chunk.model_copy(update={"delta": delta})
        yield chunk
    if suppressed:
        logger.warning(
            "resume_direct_model_speech_suppressed chunks=%d",
            suppressed,
        )


class ResumeMasteryAgent(UnifiedAgent):
    """Speak fixed startup scripts and permit only model-emitted tool calls."""

    def __init__(
        self,
        *,
        initial_scripts: tuple[str, ...],
        selected_round: str,
        highlighted_sections_per_session: int,
        main_questions_per_section: int,
        max_follow_ups_per_main: int,
        required_main_question_count: int,
        **kwargs: Any,
    ) -> None:
        if not initial_scripts or any(not script for script in initial_scripts):
            raise ValueError("Resume initial scripts must be non-empty")
        self._initial_scripts = initial_scripts
        self._selected_round = selected_round
        self._highlighted_sections_per_session = highlighted_sections_per_session
        self._main_questions_per_section = main_questions_per_section
        self._max_follow_ups_per_main = max_follow_ups_per_main
        self._required_main_question_count = required_main_question_count
        super().__init__(initial_reply="", **kwargs)

    async def on_enter(self) -> None:
        self._start_session_timer()
        started_at = time.perf_counter()
        logger.info(
            "resume_session action=start round=%s highlighted_sections=%d "
            "main_questions_per_section=%d max_follow_ups_per_main=%d "
            "required_main_questions=%d",
            self._selected_round,
            self._highlighted_sections_per_session,
            self._main_questions_per_section,
            self._max_follow_ups_per_main,
            self._required_main_question_count,
        )
        logger.info("startup_phase phase=resume_fixed_opening_start")
        try:
            for script in self._initial_scripts:
                speech_handle = self.session.say(
                    script,
                    allow_interruptions=False,
                    add_to_chat_ctx=True,
                )
                await speech_handle
            logger.info("[LLM:resume-start] status=started elapsed_ms=0")
            reply_started_at = time.perf_counter()
            try:
                reply_handle = self.session.generate_reply(
                    instructions=(
                        "Begin the selected Resume round now. Use list_resume_claims "
                        "and get_resume_claim, then call start_resume_question for "
                        "the first main question. Emit no direct text."
                    )
                )
                await reply_handle
            except Exception:
                logger.warning(
                    "[LLM:resume-start] status=failed elapsed_ms=%.2f",
                    (time.perf_counter() - reply_started_at) * 1000,
                )
                raise
            else:
                logger.info(
                    "[LLM:resume-start] status=completed elapsed_ms=%.2f",
                    (time.perf_counter() - reply_started_at) * 1000,
                )
        finally:
            logger.info(
                "startup_phase phase=resume_fixed_opening_end elapsed_ms=%.2f",
                (time.perf_counter() - started_at) * 1000,
            )

    # UNVERIFIED against LiveKit MCP; checked against pinned 1.6.6 source and docs.
    async def llm_node(
        self,
        chat_ctx: llm.ChatContext,
        tools: list[llm.Tool],
        model_settings: ModelSettings,
    ) -> AsyncIterator[Any]:
        chunks = super().llm_node(chat_ctx, tools, model_settings)
        async for chunk in tool_only_chunks(chunks):
            yield chunk

    async def on_user_turn_exceeded(self, ev: UserTurnExceededEvent) -> None:
        del ev
        logger.info("resume_user_turn_limit_reached")
