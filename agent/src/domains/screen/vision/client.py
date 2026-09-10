"""Vision model client for screen analysis."""

from __future__ import annotations

import logging

from livekit import rtc
from livekit.agents import ChatContext, llm
from livekit.plugins import openai

from domains.screen.models import (
    ResumeDetails,
    ResumeViewportObservation,
    ScreenFeedbackDecision,
)

logger = logging.getLogger(__name__)

DEFAULT_OPENROUTER_MODEL = "openai/gpt-5.5"


class VisionClient:
    def __init__(self, model: str = DEFAULT_OPENROUTER_MODEL) -> None:
        self._llm = openai.LLM.with_openrouter(
            model=model,
            parallel_tool_calls=True,
        )

    async def analyze_screen(
        self,
        frame: rtc.VideoFrame,
        system_prompt: str,
        user_prompt: str,
    ) -> ScreenFeedbackDecision:
        chat_ctx = ChatContext()
        chat_ctx.add_message(role="system", content=system_prompt)
        chat_ctx.add_message(
            role="user",
            content=[
                user_prompt,
                llm.ImageContent(
                    image=frame,
                    inference_width=1280,
                    inference_height=720,
                    inference_detail="high",
                ),
            ],
        )
        response = await self._llm.chat(
            chat_ctx=chat_ctx,
            response_format=ScreenFeedbackDecision,
        ).collect()
        return ScreenFeedbackDecision.model_validate_json(response.text)

    async def analyze_resume_viewport(
        self,
        frame: rtc.VideoFrame,
        accumulated_state: str,
    ) -> ResumeViewportObservation:
        chat_ctx = ChatContext()
        chat_ctx.add_message(
            role="system",
            content="You inspect one visible viewport of a candidate's resume. "
            "Extract only professional information...",
        )
        chat_ctx.add_message(
            role="user",
            content=[
                f"Accumulated professional resume state from earlier viewports: {accumulated_state}\nInspect the current resume viewport.",
                llm.ImageContent(
                    image=frame,
                    inference_width=1280,
                    inference_height=720,
                    inference_detail="high",
                ),
            ],
        )
        response = await self._llm.chat(
            chat_ctx=chat_ctx,
            response_format=ResumeViewportObservation,
        ).collect()
        return ResumeViewportObservation.model_validate_json(response.text)

    async def normalize_resume_details(
        self,
        accumulated_details: str,
    ) -> ResumeDetails:
        chat_ctx = ChatContext()
        chat_ctx.add_message(
            role="system",
            content="Normalize accumulated professional resume facts...",
        )
        chat_ctx.add_message(role="user", content=accumulated_details)
        response = await self._llm.chat(
            chat_ctx=chat_ctx,
            response_format=ResumeDetails,
        ).collect()
        return ResumeDetails.model_validate_json(response.text)
