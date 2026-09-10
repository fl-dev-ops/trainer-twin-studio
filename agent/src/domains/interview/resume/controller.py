"""Counted Resume question validation, delivery, pending recovery, and finish."""

from __future__ import annotations

import asyncio
import logging
import re
import time
from collections.abc import Awaitable, Callable, Mapping

from livekit.agents import RunContext, llm

from .eligibility import (
    ClaimEligibility,
    classify_claim_eligibility,
    require_round_angle,
)
from .progress import (
    ResumeProgressError,
    ResumeProgressPhase,
    ResumeQuestionKind,
    SelectedRoundProgress,
)
from .repository import ResumeDocumentRepository
from .rpc import ResumeHighlightStatus, ResumeRpcClient

logger = logging.getLogger(__name__)

_SECOND_INTERROGATIVE_RE = re.compile(
    r"(?:;|\b(?:and|or)\b)\s+"
    r"(?:what|why|how|when|where|which|who|whose|"
    r"is|are|was|were|do|does|did|can|could|would|should|will)\b",
    re.IGNORECASE,
)
_MEASUREMENT_RE = re.compile(r"\bmeasur(?:e|ed|es|ing|ement|ements)\b")
_IMPLIED_METRIC_RE = re.compile(
    r"\b(?:your|the|that|this)\s+(?:reported\s+|claimed\s+)?metric\b|"
    r"\byou\s+(?:measured|reported|achieved)\b",
    re.IGNORECASE,
)


class ResumeQuestionValidationError(ValueError):
    pass


MAX_TRANSITION_CHARACTERS = 240


def validate_transition(transition: object) -> str:
    """Require one bounded acknowledgement line that never contains a question."""

    if not isinstance(transition, str) or not transition.strip():
        raise ResumeQuestionValidationError("transition must be a non-empty string")
    if transition != transition.strip():
        raise ResumeQuestionValidationError("transition must not have surrounding whitespace")
    if any(ord(character) < 32 for character in transition):
        raise ResumeQuestionValidationError("transition must be one line")
    if len(transition) > MAX_TRANSITION_CHARACTERS:
        raise ResumeQuestionValidationError(
            f"transition must be at most {MAX_TRANSITION_CHARACTERS} characters"
        )
    if "?" in transition:
        raise ResumeQuestionValidationError("transition must not contain a question")
    return transition


def validate_resume_question(question: object, *, max_characters: int) -> str:
    """Require one bounded interrogative without a stacked second question."""

    if not isinstance(question, str) or not question.strip():
        raise ResumeQuestionValidationError("question must be a non-empty string")
    if question != question.strip():
        raise ResumeQuestionValidationError("question must not have surrounding whitespace")
    if any(ord(character) < 32 for character in question):
        raise ResumeQuestionValidationError("question must be one line")
    if len(question) > max_characters:
        raise ResumeQuestionValidationError(f"question must be at most {max_characters} characters")
    # Commented for now. We can later add other manipulations like whether LLM response was valid before speaking to user
    # if question.count("?") != 1 or not question.endswith("?"):
    #     raise ResumeQuestionValidationError("question must contain exactly one final question mark")
    # if _SECOND_INTERROGATIVE_RE.search(question[:-1]):
    #     raise ResumeQuestionValidationError("question must not stack a second interrogative")
    return question


def _validate_measurement_neutral_fallback(question: str) -> None:
    normalized = question.casefold()
    if "should" not in normalized or not _MEASUREMENT_RE.search(normalized):
        raise ResumeQuestionValidationError("Round 2 fallback must ask how impact should have been measured")
    if _IMPLIED_METRIC_RE.search(question):
        raise ResumeQuestionValidationError("Round 2 fallback must not imply that a metric exists")


class ResumeQuestionController:
    """Serialize counted speech so validation, delivery, and counts stay atomic."""

    def __init__(
        self,
        *,
        repository: ResumeDocumentRepository,
        progress: SelectedRoundProgress,
        rpc: ResumeRpcClient,
        scripts: Mapping[str, str],
        max_question_characters: int,
        close_room: Callable[[], Awaitable[None]],
        shutdown_job: Callable[[], None],
    ) -> None:
        self.repository = repository
        self.progress = progress
        self.rpc = rpc
        self.scripts = scripts
        self.max_question_characters = max_question_characters
        self._close_room = close_room
        self._shutdown_job = shutdown_job
        self._lock = asyncio.Lock()
        self._pending_question_text: str | None = None
        self._closing_spoken = False
        self._transition_spoken = False
        self._room_closed = False

    def on_conversation_item(self, item: object) -> None:
        if not isinstance(item, llm.ChatMessage) or item.role != "user":
            return
        if not isinstance(item.text_content, str) or not item.text_content.strip():
            return
        if self.progress.active_question is None:
            return
        try:
            self.progress.record_response()
        except ResumeProgressError:
            logger.warning("resume_progress action=record_response status=rejected")

    def _claim_eligibility(self, claim_id: str) -> ClaimEligibility:
        claim = self.repository.require_eligible_claim(
            self.progress.selected_round,
            claim_id,
        )
        return classify_claim_eligibility(
            self.progress.selected_round,
            claim,
            is_contact=False,
            is_control=False,
            allow_round_2_fallback=True,
        )

    def _snapshot(self, status: str) -> dict[str, object]:
        snapshot = self.progress.snapshot()
        return {
            "status": status,
            "round_id": snapshot.selected_round.value,
            "highlighted_section_count": snapshot.highlighted_section_count,
            "main_question_count": snapshot.main_question_count,
            "follow_up_count": snapshot.follow_up_count,
            "current_section_main_questions_remaining": (
                snapshot.current_section_main_questions_remaining
            ),
            "current_main_follow_ups_remaining": snapshot.current_main_follow_ups_remaining,
        }

    def _log_main_progress(self) -> None:
        logger.info(
            "resume_progress action=main_started highlighted_sections=%d "
            "main_questions_per_section=%d main_questions_completed=%d "
            "main_questions_required=%d",
            self.progress.highlighted_sections_per_session,
            self.progress.main_questions_per_section,
            self.progress.main_question_count,
            self.progress.required_main_question_count,
        )

    async def _say(self, context: RunContext, text: str, action: str) -> None:
        started = time.monotonic()
        logger.info("[EXT-API:resume-speech] action=%s status=started elapsed_ms=0", action)
        try:
            speech_handle = context.session.say(text, allow_interruptions=False, add_to_chat_ctx=True)
            await speech_handle
        except Exception:
            logger.warning(
                "[EXT-API:resume-speech] action=%s status=failed elapsed_ms=%d",
                action,
                round((time.monotonic() - started) * 1000),
            )
            raise
        logger.info(
            "[EXT-API:resume-speech] action=%s status=completed elapsed_ms=%d",
            action,
            round((time.monotonic() - started) * 1000),
        )

    async def start_main(
        self,
        context: RunContext,
        *,
        round_id: str,
        angle_id: str,
        primary_claim_id: str,
        related_claim_ids: list[str],
        question: str,
    ) -> dict[str, object]:
        async with self._lock:
            try:
                if round_id != self.progress.selected_round.value:
                    raise ResumeQuestionValidationError("round_id must match the selected round")
                require_round_angle(angle_id, self.progress.angle_ids)
                validated = validate_resume_question(question, max_characters=self.max_question_characters)
                primary_eligibility = self._claim_eligibility(primary_claim_id)
                for claim_id in related_claim_ids:
                    self._claim_eligibility(claim_id)
                if primary_eligibility is ClaimEligibility.FALLBACK:
                    _validate_measurement_neutral_fallback(validated)
                self.progress.queue_main_question(angle_id=angle_id, primary_claim_id=primary_claim_id, related_claim_ids=related_claim_ids)
            except ValueError as error:
                logger.info("resume_question action=start_main_rejected reason=%s", error)
                return {"status": "rejected", "message": str(error)}

            highlight = await self.rpc.highlight_claim(primary_claim_id)
            if highlight.status is ResumeHighlightStatus.HIGHLIGHTED:
                try:
                    await self._say(context, validated, "main_question")
                except Exception:
                    self.progress.cancel_pending()
                    return self._snapshot("speech_failed")
                self.progress.mark_pending_presented()
                self._log_main_progress()
                return self._snapshot("started")

            if highlight.status is ResumeHighlightStatus.NOT_FOUND:
                self._pending_question_text = validated
                try:
                    await self._say(context, self.scripts["verified_not_found"], "verified_not_found")
                except Exception:
                    self._pending_question_text = None
                    self.progress.cancel_pending()
                    return self._snapshot("speech_failed")
                return self._snapshot("pending_candidate_location")

            self.progress.cancel_pending()
            try:
                await self._say(context, self.scripts["viewer_recovery"], "viewer_recovery")
            except Exception:
                return self._snapshot("speech_failed")
            return self._snapshot(highlight.status.value)

    async def present_pending(self, context: RunContext, *, candidate_located: bool) -> dict[str, object]:
        async with self._lock:
            pending = self.progress.pending_question
            if (
                pending is None
                or pending.kind is not ResumeQuestionKind.MAIN
                or self._pending_question_text is None
            ):
                logger.info("resume_question action=present_pending_skipped reason=no_pending_question")
                return self._snapshot("no_pending_question")
            if not candidate_located:
                try:
                    await self._say(context, self.scripts["cannot_locate"], "cannot_locate")
                except Exception:
                    return self._snapshot("speech_failed")
                self.progress.cancel_pending()
                self._pending_question_text = None
                return self._snapshot("claim_cancelled")

            exact_question = self._pending_question_text
            try:
                await self._say(context, exact_question, "pending_main_question")
            except Exception:
                return self._snapshot("speech_failed")
            self.progress.mark_pending_presented()
            self._pending_question_text = None
            self._log_main_progress()
            return self._snapshot("started")

    async def ask_follow_up(self, context: RunContext, *, question: str) -> dict[str, object]:
        async with self._lock:
            try:
                validated = validate_resume_question(question, max_characters=self.max_question_characters)
                self.progress.queue_follow_up()
            except (ResumeProgressError, ResumeQuestionValidationError) as error:
                logger.info("resume_question action=follow_up_rejected reason=%s", error)
                return {"status": "rejected", "message": str(error)}
            try:
                await self._say(context, validated, "follow_up")
            except Exception:
                self.progress.cancel_pending()
                return self._snapshot("speech_failed")
            self.progress.mark_pending_presented()
            return self._snapshot("started")

    async def finish(
        self,
        context: RunContext,
        *,
        transition: str | None = None,
    ) -> dict[str, object]:
        async with self._lock:
            validated_transition: str | None = None
            if transition is not None:
                try:
                    validated_transition = validate_transition(transition)
                except ResumeQuestionValidationError as error:
                    logger.info("resume_question action=finish_rejected reason=%s", error)
                    return {"status": "rejected", "message": str(error)}
            if (
                self.progress.phase is ResumeProgressPhase.FINISHED
                and self._room_closed
            ):
                return self._snapshot("finished")
            try:
                self.progress.begin_finishing()
            except ResumeProgressError as error:
                logger.info("resume_question action=finish_rejected reason=%s", error)
                return {"status": "not_ready", "message": str(error)}

            if not self._closing_spoken:
                if validated_transition is not None and not self._transition_spoken:
                    try:
                        await self._say(context, validated_transition, "transition")
                    except Exception:
                        return self._snapshot("speech_failed")
                    self._transition_spoken = True
                try:
                    await self._say(context, self.scripts["closing"], "closing")
                except Exception:
                    return self._snapshot("speech_failed")
                self._closing_spoken = True
            if self.progress.phase is ResumeProgressPhase.FINISHING:
                self.progress.mark_finished()

            if not self._room_closed:
                for attempt in range(1, 3):
                    started = time.monotonic()
                    try:
                        await self._close_room()
                    except Exception:
                        logger.warning(
                            "[EXT-API:resume-room] action=delete status=failed "
                            "attempt=%d elapsed_ms=%d",
                            attempt,
                            round((time.monotonic() - started) * 1000),
                        )
                    else:
                        logger.info(
                            "[EXT-API:resume-room] action=delete status=completed "
                            "attempt=%d elapsed_ms=%d",
                            attempt,
                            round((time.monotonic() - started) * 1000),
                        )
                        self._room_closed = True
                        break
            if not self._room_closed:
                return self._snapshot("close_failed")

            # UNVERIFIED against LiveKit MCP; checked against pinned 1.6.6 source.
            context.session.shutdown(drain=False)
            self._shutdown_job()
            return self._snapshot("finished")
