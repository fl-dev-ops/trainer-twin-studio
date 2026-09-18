"""Vision-model adapter for one shared-screen frame."""

from __future__ import annotations

import logging
import os
import time

from livekit.agents import ChatContext, llm
from livekit.plugins import openai

from screen_feedback.models import ScreenFeedbackDecision, ScreenSnapshot

logger = logging.getLogger(__name__)


class ScreenVisionClient:
    def __init__(self) -> None:
        model = os.getenv("SCREEN_VISION_MODEL", "openai/gpt-5.5").strip()
        self._llm = openai.LLM.with_openrouter(model=model, parallel_tool_calls=True)
        self._model = model

    async def analyze(
        self,
        snapshot: ScreenSnapshot,
        *,
        system_prompt: str,
        last_feedback: str,
    ) -> ScreenFeedbackDecision:
        started = time.monotonic()
        question_id = snapshot.question.get("id")
        logger.info(
            "[LLM:screen-feedback] start model=%s question_id=%s revision=%d",
            self._model,
            question_id,
            snapshot.revision,
        )
        context = ChatContext()
        context.add_message(role="system", content=system_prompt)
        context.add_message(
            role="user",
            content=[
                (
                    f"Question: {snapshot.question.get('text', '')}\n"
                    f"Question type: {snapshot.question.get('questionType', '')}\n"
                    f"Surface: {snapshot.question.get('surface', '')}\n"
                    f"Seconds without progress: {snapshot.inactive_seconds:.0f}\n"
                    f"Last visual nudge: {last_feedback or 'none'}\n"
                    "Assess this current screen snapshot."
                ),
                llm.ImageContent(
                    image=snapshot.frame,
                    inference_width=1280,
                    inference_height=720,
                    inference_detail="high",
                ),
            ],
        )
        try:
            response = await self._llm.chat(
                chat_ctx=context,
                response_format=ScreenFeedbackDecision,
            ).collect()
            decision = ScreenFeedbackDecision.model_validate_json(response.text)
        except Exception as exc:
            logger.exception(
                "[LLM:screen-feedback] failed model=%s question_id=%s revision=%d "
                "elapsed_ms=%d error_type=%s",
                self._model,
                question_id,
                snapshot.revision,
                round((time.monotonic() - started) * 1000),
                type(exc).__name__,
            )
            raise
        logger.info(
            "[LLM:screen-feedback] complete model=%s question_id=%s revision=%d elapsed_ms=%d",
            self._model,
            question_id,
            snapshot.revision,
            round((time.monotonic() - started) * 1000),
        )
        return decision
