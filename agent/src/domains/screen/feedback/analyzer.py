"""Screen feedback analyzer for real-time interview feedback."""

from __future__ import annotations

import logging
import time

from livekit import rtc

from domains.screen.config import (
    DEVIATION_ANALYSIS_PROMPT,
    SCREEN_FEEDBACK_CONFIDENCE_THRESHOLD,
    SCREEN_FEEDBACK_COOLDOWN_SECONDS,
    SCREEN_FEEDBACK_STALL_SECONDS,
    STALL_ANALYSIS_PROMPT,
)
from domains.screen.models import (
    ResumeDetails,
    ResumeViewportObservation,
    ScreenFeedbackDecision,
    ScreenFeedbackTrigger,
    ScreenSnapshot,
)
from domains.screen.resume.inspection import ResumeInspectionState
from domains.screen.vision.client import VisionClient

logger = logging.getLogger(__name__)


class ScreenFeedbackAnalyzer:
    def __init__(self, vision_client: VisionClient) -> None:
        self._vision_client = vision_client

    def create_snapshot(
        self,
        frame: rtc.VideoFrame,
        question: dict[str, str],
        content_revision: int,
        inactive_seconds: float,
    ) -> ScreenSnapshot:
        return ScreenSnapshot(
            frame=frame,
            question=question,
            revision=content_revision,
            inactive_seconds=inactive_seconds,
        )

    def should_trigger_feedback(
        self,
        snapshot: ScreenSnapshot,
        *,
        last_evaluated_revision: int | None,
        stall_evaluated_revision: int | None,
    ) -> ScreenFeedbackTrigger | None:
        if (
            snapshot.inactive_seconds >= SCREEN_FEEDBACK_STALL_SECONDS
            and snapshot.revision != stall_evaluated_revision
        ):
            return ScreenFeedbackTrigger.STALL
        # A new revision only schedules deviation analysis; the vision decision
        # determines whether the approach is actually fundamentally non-viable.
        if snapshot.revision != last_evaluated_revision:
            return ScreenFeedbackTrigger.DEVIATION
        return None

    def get_trigger_prompt(self, trigger: ScreenFeedbackTrigger) -> str:
        if trigger is ScreenFeedbackTrigger.STALL:
            return STALL_ANALYSIS_PROMPT
        return DEVIATION_ANALYSIS_PROMPT

    def build_snapshot_prompt(
        self,
        snapshot: ScreenSnapshot,
        request_context: str,
    ) -> str:
        return (
            f"Question: {snapshot.question.get('text', '')}\n"
            f"Question type: {snapshot.question.get('questionType', '')}\n"
            f"Surface: {snapshot.question.get('surface', '')}\n"
            f"Approximate seconds without code or diagram progress: "
            f"{snapshot.inactive_seconds:.0f}\n"
            f"Analysis context: {request_context}\n"
            "Assess this current screen snapshot."
        )

    async def analyze_snapshot(
        self,
        snapshot: ScreenSnapshot,
        *,
        system_prompt: str,
        request_context: str,
    ) -> ScreenFeedbackDecision:
        started = time.monotonic()
        question_id = snapshot.question.get("id")
        logger.info(
            "[LLM:screen-feedback] start question_id=%s revision=%d",
            question_id,
            snapshot.revision,
        )
        try:
            decision = await self._vision_client.analyze_screen(
                frame=snapshot.frame,
                system_prompt=system_prompt,
                user_prompt=self.build_snapshot_prompt(snapshot, request_context),
            )
        except Exception as exc:
            logger.exception(
                "[LLM:screen-feedback] failed question_id=%s revision=%d "
                "elapsed_ms=%d error_type=%s",
                question_id,
                snapshot.revision,
                round((time.monotonic() - started) * 1000),
                type(exc).__name__,
            )
            raise
        logger.info(
            "[LLM:screen-feedback] complete question_id=%s revision=%d elapsed_ms=%d",
            question_id,
            snapshot.revision,
            round((time.monotonic() - started) * 1000),
        )
        return decision

    async def analyze_resume_frame(
        self,
        frame: rtc.VideoFrame,
        resume_state: ResumeInspectionState,
    ) -> ResumeViewportObservation:
        accumulated = resume_state.accumulated_details().model_dump_json()
        return await self._vision_client.analyze_resume_viewport(
            frame=frame,
            accumulated_state=accumulated,
        )

    async def normalize_resume_details(
        self,
        resume_state: ResumeInspectionState,
    ) -> ResumeDetails:
        return await self._vision_client.normalize_resume_details(
            accumulated_details=resume_state.accumulated_details().model_dump_json(),
        )

    def check_decision_quality(
        self,
        decision: ScreenFeedbackDecision,
        feedback: str,
        last_spoken_at: float,
    ) -> bool:
        decision_time = time.monotonic()
        return (
            decision.should_speak
            and decision.confidence >= SCREEN_FEEDBACK_CONFIDENCE_THRESHOLD
            and bool(feedback)
            and decision_time - last_spoken_at >= SCREEN_FEEDBACK_COOLDOWN_SECONDS
        )
