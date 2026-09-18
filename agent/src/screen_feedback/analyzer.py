"""Trigger and quality rules for background screen feedback."""

from __future__ import annotations

import time

from screen_feedback.config import (
    DEVIATION_ANALYSIS_PROMPT,
    SCREEN_FEEDBACK_CONFIDENCE_THRESHOLD,
    SCREEN_FEEDBACK_COOLDOWN_SECONDS,
    SCREEN_FEEDBACK_STALL_SECONDS,
    STALL_ANALYSIS_PROMPT,
)
from screen_feedback.models import (
    ScreenFeedbackDecision,
    ScreenFeedbackTrigger,
    ScreenSnapshot,
)
from screen_feedback.vision import ScreenVisionClient


class ScreenFeedbackAnalyzer:
    def __init__(self) -> None:
        self._vision = ScreenVisionClient()

    def trigger(
        self,
        snapshot: ScreenSnapshot,
        *,
        last_evaluated_revision: int,
        stall_evaluated_revision: int | None,
    ) -> ScreenFeedbackTrigger | None:
        if (
            snapshot.inactive_seconds >= SCREEN_FEEDBACK_STALL_SECONDS
            and snapshot.revision != stall_evaluated_revision
        ):
            return ScreenFeedbackTrigger.STALL
        if snapshot.revision != last_evaluated_revision:
            return ScreenFeedbackTrigger.DEVIATION
        return None

    async def analyze(
        self,
        snapshot: ScreenSnapshot,
        trigger: ScreenFeedbackTrigger,
        last_feedback: str,
    ) -> ScreenFeedbackDecision:
        prompt = (
            STALL_ANALYSIS_PROMPT
            if trigger is ScreenFeedbackTrigger.STALL
            else DEVIATION_ANALYSIS_PROMPT
        )
        return await self._vision.analyze(
            snapshot,
            system_prompt=prompt,
            last_feedback=last_feedback,
        )

    def should_speak(
        self,
        decision: ScreenFeedbackDecision,
        *,
        last_spoken_at: float,
    ) -> bool:
        return bool(
            decision.should_speak
            and decision.confidence >= SCREEN_FEEDBACK_CONFIDENCE_THRESHOLD
            and decision.feedback.strip()
            and time.monotonic() - last_spoken_at >= SCREEN_FEEDBACK_COOLDOWN_SECONDS
        )
