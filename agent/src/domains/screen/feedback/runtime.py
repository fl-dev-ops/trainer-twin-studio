"""Screen feedback runtime for real-time interview feedback."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import Awaitable, Callable

from livekit import rtc
from livekit.agents import AgentSession, function_tool

from domains.screen.config import (
    ON_DEMAND_ANALYSIS_PROMPT,
    RESUME_FRAME_WAIT_SECONDS,
    RESUME_MAX_VIEWPORTS,
    RESUME_SCREEN_SHARE_REQUIRED_MESSAGE,
    SCREEN_FEEDBACK_INTERVAL_SECONDS,
    SCREEN_SHARE_REQUIRED_MESSAGE,
    SUPPORTED_SURFACES,
    SURFACE_STATE_TOPIC,
)
from domains.screen.feedback.analyzer import ScreenFeedbackAnalyzer
from domains.screen.models import (
    ResumeEndState,
    ResumeScrollbarPosition,
    ScreenFeedbackTrigger,
    ScreenSnapshot,
)
from domains.screen.resume.inspection import (
    ResumeInspectionState,
    resume_viewport_metadata,
    resume_viewport_signature,
)
from domains.screen.vision.client import VisionClient

logger = logging.getLogger(__name__)


class ScreenFeedbackRuntime:
    """Samples a shared screen and speaks only high-confidence interview nudges."""

    def __init__(
        self,
        *,
        room: rtc.Room,
        participant_identity: str,
        timer_enabled: bool = True,
        note_sink: Callable[[str], Awaitable[None]] | None = None,
        code_highlight_sink: Callable[[int, int], Awaitable[None]] | None = None,
    ) -> None:
        self._room = room
        self._participant_identity = participant_identity
        self._timer_enabled = timer_enabled
        self._note_sink = note_sink
        self._code_highlight_sink = code_highlight_sink
        self._vision_client = VisionClient()
        self._analyzer = ScreenFeedbackAnalyzer(self._vision_client)
        self._session: AgentSession | None = None
        self._active_question: dict[str, str] | None = None
        self._surface_visible = False
        self._visible_surface: str | None = None
        self._latest_frame: rtc.VideoFrame | None = None
        self._fresh_frame_event = asyncio.Event()
        self._video_stream: rtc.VideoStream | None = None
        self._video_task: asyncio.Task[None] | None = None
        self._timer_task: asyncio.Task[None] | None = None
        self._cleanup_tasks: set[asyncio.Task[None]] = set()
        self._analysis_lock = asyncio.Lock()
        self._resume_capture_active = False
        self._resume_state = ResumeInspectionState()
        self._content_revision = 0
        self._last_evaluated_revision: int | None = 0
        self._stall_evaluated_revision: int | None = None
        self._unchanged_since = time.monotonic()
        self._last_feedback = ""
        self._last_spoken_at = 0.0
        self._started = False

    async def start(self, session: AgentSession) -> None:
        """Start the screen feedback runtime."""
        if self._started:
            return
        self._started = True
        self._session = session

        self._room.on("track_published", self._on_track_published)
        self._room.on("track_subscribed", self._on_track_subscribed)
        self._room.on("track_unsubscribed", self._on_track_unsubscribed)
        self._room.on("data_received", self._on_data_received)

        self._sync_screen_subscription()

        if self._timer_enabled:
            self._timer_task = asyncio.create_task(
                self._run_timer(),
                name=f"screen-feedback:{self._room.name}",
            )
            logger.info(
                "Screen feedback timer started room=%s interval_seconds=%d",
                self._room.name,
                SCREEN_FEEDBACK_INTERVAL_SECONDS,
            )

    async def close(self) -> None:
        """Close the screen feedback runtime."""
        if not self._started:
            return
        self._started = False

        self._room.off("track_published", self._on_track_published)
        self._room.off("track_subscribed", self._on_track_subscribed)
        self._room.off("track_unsubscribed", self._on_track_unsubscribed)
        self._room.off("data_received", self._on_data_received)

        if self._timer_task is not None:
            self._timer_task.cancel()
            await asyncio.gather(self._timer_task, return_exceptions=True)
            self._timer_task = None
        await self._stop_video_stream()
        if self._cleanup_tasks:
            await asyncio.gather(*self._cleanup_tasks, return_exceptions=True)
            self._cleanup_tasks.clear()

    async def on_question_started(self, question: dict[str, str]) -> None:
        """Handle question start event."""
        if self._resume_capture_active:
            self._resume_capture_active = False
            logger.info(
                "Resume screen capture stopped room=%s reason=question_started",
                self._room.name,
            )
        surface = question.get("surface")
        self._active_question = question if surface in SUPPORTED_SURFACES else None
        self._content_revision = 0
        self._last_evaluated_revision = 0
        self._stall_evaluated_revision = None
        self._unchanged_since = time.monotonic()
        self._last_feedback = ""
        self._last_spoken_at = 0.0
        self._sync_screen_subscription()
        logger.info(
            "Screen feedback question state room=%s question_id=%s surface=%s active=%s",
            self._room.name,
            question.get("id"),
            surface,
            self._active_question is not None,
        )

    def _on_track_published(
        self,
        publication: rtc.RemoteTrackPublication,
        participant: rtc.RemoteParticipant,
    ) -> None:
        if (
            participant.identity == self._participant_identity
            and publication.source == rtc.TrackSource.SOURCE_SCREENSHARE
        ):
            self._sync_screen_subscription()

    def _on_track_subscribed(
        self,
        track: rtc.Track,
        publication: rtc.RemoteTrackPublication,
        participant: rtc.RemoteParticipant,
    ) -> None:
        if (
            participant.identity == self._participant_identity
            and publication.source == rtc.TrackSource.SOURCE_SCREENSHARE
        ):
            logger.info(
                "Screen-share track subscribed room=%s track_sid=%s "
                "resume_capture_active=%s",
                self._room.name,
                publication.sid,
                self._resume_capture_active,
            )
            self._start_video_stream(track)

    def _on_track_unsubscribed(
        self,
        track: rtc.Track,
        publication: rtc.RemoteTrackPublication,
        participant: rtc.RemoteParticipant,
    ) -> None:
        if (
            participant.identity == self._participant_identity
            and publication.source == rtc.TrackSource.SOURCE_SCREENSHARE
        ):
            logger.info(
                "Screen-share track unsubscribed room=%s track_sid=%s "
                "resume_capture_active=%s",
                self._room.name,
                publication.sid,
                self._resume_capture_active,
            )
            self._latest_frame = None
            self._fresh_frame_event.clear()
            if self._video_task is not None:
                self._video_task.cancel()
                self._video_task = None
            if self._video_stream is not None:
                stream = self._video_stream
                self._video_stream = None
                task = asyncio.create_task(stream.aclose())
                self._cleanup_tasks.add(task)
                task.add_done_callback(self._cleanup_tasks.discard)

    def _on_data_received(self, packet: rtc.DataPacket) -> None:
        if packet.topic != SURFACE_STATE_TOPIC:
            return
        if (
            packet.participant is None
            or packet.participant.identity != self._participant_identity
        ):
            return
        try:
            payload = json.loads(packet.data.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            logger.warning("Ignored invalid candidate surface state payload")
            return
        if (
            not isinstance(payload, dict)
            or payload.get("type") != "candidate_surface_state"
        ):
            return

        surface = payload.get("surface")
        previous_surface = self._visible_surface
        was_visible = self._surface_visible
        self._surface_visible = payload.get("visible") is True
        self._visible_surface = surface if surface in SUPPORTED_SURFACES else None
        content_revision = payload.get("content_revision")
        if (
            not isinstance(content_revision, int)
            or isinstance(content_revision, bool)
            or content_revision < 0
        ):
            content_revision = 0

        now = time.monotonic()
        if (
            not self._surface_visible
            or not was_visible
            or previous_surface != self._visible_surface
        ):
            self._content_revision = content_revision
            self._last_evaluated_revision = content_revision
            self._stall_evaluated_revision = None
            self._unchanged_since = now
        elif content_revision != self._content_revision:
            self._content_revision = content_revision
            self._stall_evaluated_revision = None
            self._unchanged_since = now
        self._sync_screen_subscription()

    def _screen_publication(self) -> rtc.RemoteTrackPublication | None:
        participant = self._room.remote_participants.get(self._participant_identity)
        if participant is None:
            return None
        for publication in participant.track_publications.values():
            if publication.source == rtc.TrackSource.SOURCE_SCREENSHARE:
                return publication
        return None

    def _should_subscribe_to_screen(self) -> bool:
        question = self._active_question
        return bool(
            self._resume_capture_active
            or (
                question
                and self._surface_visible
                and self._visible_surface == question.get("surface")
            )
        )

    def _sync_screen_subscription(self) -> None:
        if not self._started:
            return
        publication = self._screen_publication()
        if publication is None:
            return
        should_subscribe = self._should_subscribe_to_screen()
        if publication.subscribed != should_subscribe:
            logger.info(
                "Screen-share subscription change requested room=%s track_sid=%s "
                "subscribed=%s resume_capture_active=%s",
                self._room.name,
                publication.sid,
                should_subscribe,
                self._resume_capture_active,
            )
            try:
                publication.set_subscribed(should_subscribe)
            except Exception as exc:
                logger.exception(
                    "Screen-share subscription change failed room=%s track_sid=%s "
                    "subscribed=%s error_type=%s error=%r",
                    self._room.name,
                    publication.sid,
                    should_subscribe,
                    type(exc).__name__,
                    exc,
                )
                raise
        if (
            should_subscribe
            and publication.track is not None
            and self._video_stream is None
        ):
            self._start_video_stream(publication.track)

    def _start_video_stream(self, track: rtc.Track) -> None:
        if self._video_task is not None:
            self._video_task.cancel()
        if self._video_stream is not None:
            task = asyncio.create_task(self._video_stream.aclose())
            self._cleanup_tasks.add(task)
            task.add_done_callback(self._cleanup_tasks.discard)

        self._video_stream = rtc.VideoStream(track, capacity=1)
        stream = self._video_stream

        async def consume() -> None:
            try:
                async for event in stream:
                    self._latest_frame = event.frame
                    self._fresh_frame_event.set()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.exception(
                    "Screen-share video stream failed room=%s error_type=%s error=%r",
                    self._room.name,
                    type(exc).__name__,
                    exc,
                )

        self._video_task = asyncio.create_task(
            consume(),
            name=f"screen-feedback-video:{self._room.name}",
        )

    async def _stop_video_stream(self) -> None:
        if self._video_task is not None:
            self._video_task.cancel()
            await asyncio.gather(self._video_task, return_exceptions=True)
            self._video_task = None
        if self._video_stream is not None:
            await self._video_stream.aclose()
            self._video_stream = None
        self._latest_frame = None
        self._fresh_frame_event.clear()

    async def _run_timer(self) -> None:
        while True:
            await asyncio.sleep(SCREEN_FEEDBACK_INTERVAL_SECONDS)
            try:
                await self._evaluate_latest_frame()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception(
                    "Screen feedback evaluation failed room=%s", self._room.name
                )

    def _can_evaluate(self) -> bool:
        session = self._session
        return bool(
            self._current_snapshot() is not None
            and session is not None
            and session.agent_state == "listening"
            and session.user_state != "speaking"
        )

    def _current_snapshot(self) -> ScreenSnapshot | None:
        question = self._active_question
        frame = self._latest_frame
        if (
            question is None
            or not self._surface_visible
            or self._visible_surface != question.get("surface")
            or frame is None
        ):
            return None
        return ScreenSnapshot(
            frame=frame,
            question=question,
            revision=self._content_revision,
            inactive_seconds=max(0.0, time.monotonic() - self._unchanged_since),
        )

    def _snapshot_is_current(self, snapshot: ScreenSnapshot) -> bool:
        question = self._active_question
        return bool(
            question is not None
            and self._surface_visible
            and question.get("id") == snapshot.question.get("id")
            and self._visible_surface == snapshot.question.get("surface")
            and self._content_revision == snapshot.revision
        )

    async def _evaluate_latest_frame(self) -> None:
        if not self._can_evaluate():
            return

        snapshot = self._current_snapshot()
        session = self._session
        if snapshot is None or session is None:
            return

        trigger = self._analyzer.should_trigger_feedback(
            snapshot,
            last_evaluated_revision=self._last_evaluated_revision,
            stall_evaluated_revision=self._stall_evaluated_revision,
        )
        if trigger is None:
            logger.debug(
                "Skipped unchanged screen room=%s revision=%d inactive_seconds=%.0f",
                self._room.name,
                snapshot.revision,
                snapshot.inactive_seconds,
            )
            return

        async with self._analysis_lock:
            decision = await self._analyzer.analyze_snapshot(
                snapshot,
                system_prompt=self._analyzer.get_trigger_prompt(trigger),
                request_context=(
                    f"Last spoken visual nudge: {self._last_feedback or 'none'}"
                ),
            )

        if not self._snapshot_is_current(snapshot):
            return
        if not self._can_evaluate():
            logger.debug(
                "Skipped screen feedback after analysis because conversation state changed room=%s",
                self._room.name,
            )
            return

        self._last_evaluated_revision = snapshot.revision
        if trigger is ScreenFeedbackTrigger.STALL:
            self._stall_evaluated_revision = snapshot.revision

        feedback = decision.feedback.strip()
        should_speak = self._analyzer.check_decision_quality(
            decision,
            feedback,
            self._last_spoken_at,
        )
        logger.info(
            "Screen feedback decision room=%s question_id=%s trigger=%s "
            "should_speak=%s confidence=%.2f code_completion_percent=%s "
            "highlight_from_line=%s highlight_to_line=%s",
            self._room.name,
            snapshot.question.get("id"),
            trigger.value,
            should_speak,
            decision.confidence,
            decision.code_completion_percent,
            decision.highlight_from_line,
            decision.highlight_to_line,
        )
        if not should_speak:
            return

        question_type = snapshot.question.get("questionType")
        requires_code_highlight = (
            trigger is ScreenFeedbackTrigger.STALL
            and question_type in {"coding", "machine-coding"}
            and decision.code_completion_percent is not None
            and decision.code_completion_percent >= 50
        )
        if requires_code_highlight:
            from_line = decision.highlight_from_line
            to_line = decision.highlight_to_line
            if (
                self._code_highlight_sink is None
                or from_line is None
                or to_line is None
                or from_line > to_line
                or not feedback.endswith("?")
            ):
                logger.warning(
                    "Skipped coding stall feedback without valid question and highlight "
                    "room=%s question_id=%s from_line=%s to_line=%s",
                    self._room.name,
                    snapshot.question.get("id"),
                    from_line,
                    to_line,
                )
                return
            try:
                await self._code_highlight_sink(from_line, to_line)
            except Exception:
                logger.exception(
                    "Failed to highlight coding stall feedback room=%s question_id=%s "
                    "from_line=%d to_line=%d",
                    self._room.name,
                    snapshot.question.get("id"),
                    from_line,
                    to_line,
                )
                return
            if not self._snapshot_is_current(snapshot) or not self._can_evaluate():
                logger.debug(
                    "Skipped coding stall question after highlight because state changed room=%s",
                    self._room.name,
                )
                return

        session.say(feedback, allow_interruptions=True, add_to_chat_ctx=False)
        logger.info(
            "Screen feedback spoken room=%s question_id=%s highlighted=%s",
            self._room.name,
            snapshot.question.get("id"),
            requires_code_highlight,
        )
        self._last_feedback = feedback
        self._last_spoken_at = time.monotonic()
        if self._note_sink is not None:
            question_id = snapshot.question.get("id")
            if requires_code_highlight:
                note = (
                    f'[Internal: a separate screen observer asked aloud: "{feedback}". '
                    "This is a work-in-progress nudge, not a submitted answer or formal "
                    "follow-up. If the candidate answers it, briefly acknowledge their "
                    f"reasoning and let them continue. Question {question_id} is still unanswered.]"
                )
            else:
                note = (
                    f'[Internal: a separate screen observer said aloud: "{feedback}". '
                    "This was not your turn and does not open a thread. Question "
                    f"{question_id} is still unanswered.]"
                )
            try:
                await self._note_sink(note)
            except Exception:
                logger.exception(
                    "Failed to record screen nudge note room=%s question_id=%s",
                    self._room.name,
                    question_id,
                )

    async def inspect_shared_screen(self, user_request: str) -> dict[str, object]:
        """Inspect the latest shared-screen frame for an explicit candidate request."""
        question = self._active_question
        if question is not None and question.get("surface") == "code":
            return {
                "status": "editor_code_available",
                "response_guidance": (
                    "Use read_code_range, then highlight_code only when the candidate "
                    "has written meaningful code. Do not inspect the shared screen for "
                    "editor-code feedback."
                ),
            }
        if (
            question is None
            or not self._surface_visible
            or self._visible_surface != question.get("surface")
        ):
            return self._recovery_result(
                status="surface_unavailable",
                candidate_message=SCREEN_SHARE_REQUIRED_MESSAGE,
            )
        if self._screen_publication() is None:
            return self._recovery_result(
                status="screen_share_required",
                candidate_message=SCREEN_SHARE_REQUIRED_MESSAGE,
            )
        snapshot = self._current_snapshot()
        if snapshot is None:
            return self._recovery_result(
                status="loading",
                candidate_message=(
                    "Please keep screen sharing enabled with the active editor or "
                    "whiteboard visible for a moment, then ask me again."
                ),
            )

        request = user_request.strip() if isinstance(user_request, str) else ""
        try:
            async with self._analysis_lock:
                decision = await self._analyzer.analyze_snapshot(
                    snapshot,
                    system_prompt=ON_DEMAND_ANALYSIS_PROMPT,
                    request_context=(
                        "Candidate request: "
                        f"{request or 'Give feedback on my current work.'}"
                    ),
                )
        except Exception:
            logger.exception(
                "On-demand screen inspection failed room=%s", self._room.name
            )
            return {
                "status": "error",
                "response_guidance": (
                    "Ask the candidate to keep working and repeat their screen-related "
                    "question in a moment."
                ),
            }

        if not self._snapshot_is_current(snapshot):
            return {
                "status": "changed",
                "response_guidance": (
                    "The candidate changed their work during inspection. Call "
                    "inspect_shared_screen once more before answering."
                ),
            }

        feedback = decision.feedback.strip()
        if not feedback:
            feedback = (
                "Ask the candidate which specific part of the current approach they "
                "want to reason through."
            )

        now = time.monotonic()
        self._last_evaluated_revision = snapshot.revision
        self._stall_evaluated_revision = (
            snapshot.revision
            if snapshot.inactive_seconds >= 60  # SCREEN_FEEDBACK_STALL_SECONDS
            else None
        )
        self._last_feedback = feedback
        self._last_spoken_at = now
        logger.info(
            "On-demand screen inspection completed room=%s question_id=%s revision=%d",
            self._room.name,
            question.get("id"),
            snapshot.revision,
        )
        return {
            "status": "ok",
            "surface": question.get("surface"),
            "observation_and_hint": feedback,
        }

    async def inspect_resume_screen(
        self,
        *,
        end_of_document_confirmed: bool = False,
        finish_with_available_details: bool = False,
    ) -> dict[str, object]:
        """Inspect and accumulate one visible resume viewport."""
        inspection_started_at = time.monotonic()
        logger.info(
            "Resume viewport inspection started room=%s viewport=%d "
            "end_of_document_confirmed=%s",
            self._room.name,
            self._resume_state.viewport_count + 1,
            end_of_document_confirmed,
        )

        if self._resume_state.completed_details is not None:
            return await self._complete_resume_inspection()

        if finish_with_available_details:
            async with self._analysis_lock:
                return await self._complete_resume_inspection(
                    use_accumulated_details=True,
                    reason="candidate_stopped_resume_inspection",
                )

        if end_of_document_confirmed and self._resume_state.can_finalize():
            async with self._analysis_lock:
                return await self._complete_resume_inspection()

        if self._resume_state.viewport_count >= RESUME_MAX_VIEWPORTS:
            logger.warning(
                "Resume viewport cap reached; finalizing accumulated details "
                "room=%s viewports=%d elapsed_ms=%.1f",
                self._room.name,
                self._resume_state.viewport_count,
                (time.monotonic() - inspection_started_at) * 1000,
            )
            async with self._analysis_lock:
                return await self._complete_resume_inspection()

        if self._screen_publication() is None:
            logger.warning(
                "Resume screen publication unavailable room=%s elapsed_ms=%.1f",
                self._room.name,
                (time.monotonic() - inspection_started_at) * 1000,
            )
            if self._resume_capture_active or self._resume_state.viewport_count > 0:
                async with self._analysis_lock:
                    return await self._complete_resume_inspection(
                        use_accumulated_details=True,
                        reason="screen_share_unavailable",
                    )
            return self._recovery_result(
                status="screen_share_required",
                candidate_message=RESUME_SCREEN_SHARE_REQUIRED_MESSAGE,
            )

        async with self._analysis_lock:
            if not self._resume_capture_active:
                self._resume_capture_active = True
                logger.info(
                    "Resume screen capture started room=%s", self._room.name
                )
            stage = "subscription"
            stage_started_at = time.monotonic()
            try:
                self._sync_screen_subscription()

                stage = "frame_wait"
                stage_started_at = time.monotonic()
                if self._latest_frame is None:
                    self._fresh_frame_event.clear()
                    await asyncio.wait_for(
                        self._fresh_frame_event.wait(),
                        timeout=RESUME_FRAME_WAIT_SECONDS,
                    )
                frame = self._latest_frame
                if frame is None:
                    raise TimeoutError("no video frame available from screen share")

                frame_wait_ms = (time.monotonic() - stage_started_at) * 1000
                logger.info(
                    "Resume frame acquired room=%s viewport=%d elapsed_ms=%.1f",
                    self._room.name,
                    self._resume_state.viewport_count + 1,
                    frame_wait_ms,
                )

                stage = "vision_analysis"
                stage_started_at = time.monotonic()
                observation = await self._analyzer.analyze_resume_frame(
                    frame, self._resume_state
                )
                vision_analysis_ms = (time.monotonic() - stage_started_at) * 1000
                logger.info(
                    "Resume image analysis completed room=%s viewport=%d "
                    "elapsed_ms=%.1f",
                    self._room.name,
                    self._resume_state.viewport_count + 1,
                    vision_analysis_ms,
                )
            except TimeoutError as exc:
                logger.warning(
                    "Resume viewport inspection timed out room=%s viewport=%d "
                    "stage=%s stage_elapsed_ms=%.1f total_elapsed_ms=%.1f "
                    "error_type=%s error=%r",
                    self._room.name,
                    self._resume_state.viewport_count + 1,
                    stage,
                    (time.monotonic() - stage_started_at) * 1000,
                    (time.monotonic() - inspection_started_at) * 1000,
                    type(exc).__name__,
                    exc,
                    exc_info=True,
                )
                return await self._complete_resume_inspection(
                    use_accumulated_details=True,
                    reason=f"{stage}_timeout",
                )
            except Exception as exc:
                logger.exception(
                    "Resume viewport inspection failed room=%s viewport=%d "
                    "stage=%s stage_elapsed_ms=%.1f total_elapsed_ms=%.1f "
                    "error_type=%s error=%r",
                    self._room.name,
                    self._resume_state.viewport_count + 1,
                    stage,
                    (time.monotonic() - stage_started_at) * 1000,
                    (time.monotonic() - inspection_started_at) * 1000,
                    type(exc).__name__,
                    exc,
                )
                return await self._complete_resume_inspection(
                    use_accumulated_details=True,
                    reason=f"{stage}_error",
                )

            self._resume_state.viewport_count += 1

            visible_continuation = bool(
                observation.content_clipped_at_bottom
                or observation.scrollbar_position
                is ResumeScrollbarPosition.ABOVE_BOTTOM
                or (
                    observation.page_current is not None
                    and observation.page_total is not None
                    and observation.page_current < observation.page_total
                )
            )
            if visible_continuation:
                observation.end_state = ResumeEndState.MORE_CONTENT
            elif (observation.page_current is None) != (
                observation.page_total is None
            ) or (
                observation.page_current is not None
                and observation.page_total is not None
                and observation.page_current > observation.page_total
            ):
                observation.end_state = ResumeEndState.UNCERTAIN

            signature = resume_viewport_signature(observation)
            unchanged = signature == self._resume_state.last_viewport_signature
            self._resume_state.last_viewport_signature = signature

            logger.info(
                "Resume viewport processed room=%s viewport=%d end_state=%s "
                "unchanged=%s clipped_at_bottom=%s page_current=%s page_total=%s "
                "frame_wait_ms=%.1f image_analysis_ms=%.1f total_elapsed_ms=%.1f",
                self._room.name,
                self._resume_state.viewport_count,
                observation.end_state.value,
                unchanged,
                observation.content_clipped_at_bottom,
                observation.page_current,
                observation.page_total,
                frame_wait_ms,
                vision_analysis_ms,
                (time.monotonic() - inspection_started_at) * 1000,
            )

            if unchanged:
                return {
                    "status": "unchanged",
                    "screen_available": True,
                    **resume_viewport_metadata(observation),
                    "candidate_message": (
                        "I am still seeing the same resume section. Please scroll "
                        "further down, then tell me when the next section is visible."
                    ),
                    "response_guidance": (
                        "Say candidate_message and wait before inspecting again."
                    ),
                }

            self._resume_state.merge(observation)
            if observation.end_state is ResumeEndState.MORE_CONTENT:
                instruction = observation.scroll_instruction.strip() or (
                    "Please scroll further down until the next part of the resume is "
                    "fully visible, then tell me when it is ready."
                )
                return {
                    "status": "more_content",
                    "screen_available": True,
                    **resume_viewport_metadata(observation),
                    "candidate_message": instruction,
                    "response_guidance": (
                        "Say candidate_message exactly, wait for the candidate to "
                        "scroll and say they are ready, then call inspect_resume_screen "
                        "again with end_of_document_confirmed set to false."
                    ),
                }

            if observation.end_state is ResumeEndState.APPARENT_END:
                return {
                    "status": "apparent_end",
                    "screen_available": True,
                    **resume_viewport_metadata(observation),
                    "candidate_message": (
                        "Is this the last page or the end of your resume?"
                    ),
                    "response_guidance": (
                        "Ask candidate_message. If the candidate confirms, call "
                        "inspect_resume_screen with end_of_document_confirmed set to "
                        "true. Do not start the project discussion yet."
                    ),
                }

            return {
                "status": "uncertain",
                "screen_available": True,
                **resume_viewport_metadata(observation),
                "candidate_message": (
                    "I cannot confirm the end of the resume from this view. Is there "
                    "more content below? If there is, please scroll to it. If not, "
                    "please show the very bottom of the last page."
                ),
                "response_guidance": (
                    "Say candidate_message, wait for the candidate to adjust the view, "
                    "then inspect again. Candidate confirmation cannot finalize an "
                    "uncertain or visibly clipped viewport."
                ),
            }

    async def _complete_resume_inspection(
        self,
        *,
        use_accumulated_details: bool = False,
        reason: str | None = None,
    ) -> dict[str, object]:
        completion_started_at = time.monotonic()
        if self._resume_capture_active:
            self._resume_capture_active = False
            try:
                self._sync_screen_subscription()
            except Exception:
                logger.exception(
                    "Failed to release resume screen capture room=%s reason=%s",
                    self._room.name,
                    reason or "completion",
                )
            logger.info(
                "Resume screen capture stopped room=%s reason=%s",
                self._room.name,
                reason or "completion",
            )

        completed = self._resume_state.completed_details
        if completed is None:
            if use_accumulated_details:
                completed = self._resume_state.accumulated_details()
                self._resume_state.finalized_with_partial_details = True
                self._resume_state.finalization_reason = reason or "inspection_error"
                logger.warning(
                    "Resume inspection finalized with accumulated details room=%s "
                    "viewports=%d reason=%s",
                    self._room.name,
                    self._resume_state.viewport_count,
                    self._resume_state.finalization_reason,
                )
            else:
                normalization_started_at = time.monotonic()
                try:
                    completed = await self._analyzer.normalize_resume_details(
                        self._resume_state
                    )
                except Exception as exc:
                    logger.exception(
                        "Resume normalization failed room=%s elapsed_ms=%.1f "
                        "error_type=%s error=%r",
                        self._room.name,
                        (time.monotonic() - normalization_started_at) * 1000,
                        type(exc).__name__,
                        exc,
                    )
                    completed = self._resume_state.accumulated_details()
                    self._resume_state.finalized_with_partial_details = True
                    self._resume_state.finalization_reason = "normalization_error"
                else:
                    logger.info(
                        "Resume normalization completed room=%s elapsed_ms=%.1f",
                        self._room.name,
                        (time.monotonic() - normalization_started_at) * 1000,
                    )
            self._resume_state.completed_details = completed

        details_complete = not self._resume_state.finalized_with_partial_details
        if details_complete:
            response_guidance = (
                "The complete professional resume context is now available. Tell the "
                "candidate they can stop screen sharing. Select one recent or relevant "
                "project from resume_details and discuss its purpose, their personal "
                "ownership, one technical challenge, and the result, one question at a "
                "time, before starting the configured interview plan."
            )
        else:
            response_guidance = (
                "Resume inspection ended early, so resume_details contains only the "
                "professional facts successfully extracted before the issue. Tell the "
                "candidate they can stop screen sharing and continue without retrying. "
                "Use the available resume details plus their spoken introduction for the "
                "project discussion. If no project is available, ask them to choose one."
            )

        logger.info(
            "Resume finalization completed room=%s viewports=%d "
            "resume_details_complete=%s reason=%s elapsed_ms=%.1f",
            self._room.name,
            self._resume_state.viewport_count,
            details_complete,
            self._resume_state.finalization_reason,
            (time.monotonic() - completion_started_at) * 1000,
        )

        return {
            "status": "complete",
            "screen_available": (
                self._resume_state.finalization_reason != "screen_share_unavailable"
            ),
            "resume_details": completed.model_dump(),
            "resume_details_complete": details_complete,
            "finalization_reason": self._resume_state.finalization_reason,
            "response_guidance": response_guidance,
        }

    @staticmethod
    def _recovery_result(
        *,
        status: str,
        candidate_message: str,
    ) -> dict[str, object]:
        return {
            "status": status,
            "screen_available": False,
            "candidate_message": candidate_message,
            "response_guidance": (
                "Say candidate_message to the candidate and continue the interview. "
                "This is a normal recoverable state. Do not call end_call."
            ),
        }


def build_screen_inspection_tool(runtime: ScreenFeedbackRuntime):
    """Build the screen inspection tool."""

    @function_tool(
        name="inspect_shared_screen",
        description=(
            "Inspect the candidate's current shared whiteboard. Use only for an active "
            "whiteboard request about visible diagram state. Do not use this for editor "
            "code; use read_code_range, and highlight_code only after meaningful code "
            "exists. Pass "
            "their request in user_request. The tool returns a brief visible observation "
            "and one next-step hint without adding the image to the main chat context. "
            "If screen sharing is disabled, say the returned candidate_message and "
            "continue the interview; never end the call for this reason."
        ),
    )
    async def inspect_shared_screen(user_request: str = "") -> dict[str, object]:
        return await runtime.inspect_shared_screen(user_request)

    return inspect_shared_screen


def build_resume_inspection_tool(runtime: ScreenFeedbackRuntime):
    """Build the resume inspection tool."""

    @function_tool(
        name="inspect_resume_screen",
        description=(
            "Inspect and accumulate the candidate's shared resume one visible viewport "
            "at a time. Call it after the candidate has shared their screen, opened the "
            "resume, and said the current view is ready. Follow the returned "
            "candidate_message exactly for more_content, unchanged, uncertain, and "
            "apparent_end statuses. After apparent_end, ask whether this is the last "
            "page or end of the resume. Only after the candidate confirms, call this "
            "tool with end_of_document_confirmed set to true. If the candidate stops "
            "sharing or asks to skip the resume, call with finish_with_available_details "
            "set to true. A complete result returns all professional details successfully "
            "accumulated and indicates whether they are complete or partial. Screenshots "
            "and personal contact information are never returned."
        ),
    )
    async def inspect_resume_screen(
        end_of_document_confirmed: bool = False,
        finish_with_available_details: bool = False,
    ) -> dict[str, object]:
        return await runtime.inspect_resume_screen(
            end_of_document_confirmed=end_of_document_confirmed,
            finish_with_available_details=finish_with_available_details,
        )

    return inspect_resume_screen
