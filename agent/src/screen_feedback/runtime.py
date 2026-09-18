"""Subscribe to screen share and provide gated background feedback."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import Awaitable, Callable

from livekit import rtc
from livekit.agents import AgentSession

from screen_feedback.analyzer import ScreenFeedbackAnalyzer
from screen_feedback.config import (
    SCREEN_FEEDBACK_INTERVAL_SECONDS,
    SUPPORTED_SURFACES,
    SURFACE_STATE_TOPIC,
)
from screen_feedback.models import ScreenFeedbackTrigger, ScreenSnapshot

logger = logging.getLogger(__name__)


class ScreenFeedbackRuntime:
    def __init__(
        self,
        *,
        room: rtc.Room,
        participant_identity: str,
        note_sink: Callable[[str], Awaitable[None]],
    ) -> None:
        self._room = room
        self._participant_identity = participant_identity
        self._note_sink = note_sink
        self._analyzer = ScreenFeedbackAnalyzer()
        self._session: AgentSession | None = None
        self._question: dict[str, str] | None = None
        self._surface_visible = False
        self._surface: str | None = None
        self._revision = 0
        self._last_evaluated_revision = 0
        self._stall_evaluated_revision: int | None = None
        self._unchanged_since = time.monotonic()
        self._last_feedback = ""
        self._last_spoken_at = 0.0
        self._latest_frame: rtc.VideoFrame | None = None
        self._video_stream: rtc.VideoStream | None = None
        self._video_task: asyncio.Task[None] | None = None
        self._timer_task: asyncio.Task[None] | None = None
        self._analysis_lock = asyncio.Lock()
        self._started = False

    async def start(self, session: AgentSession) -> None:
        if self._started:
            return
        self._started = True
        self._session = session
        self._room.on("track_published", self._on_track_published)
        self._room.on("track_subscribed", self._on_track_subscribed)
        self._room.on("track_unsubscribed", self._on_track_unsubscribed)
        self._room.on("data_received", self._on_data_received)
        self._sync_subscription()
        self._timer_task = asyncio.create_task(
            self._run_timer(),
            name=f"screen-feedback:{self._room.name}",
        )
        logger.info(
            "[JOB:screen-feedback] started room=%s interval_seconds=%d",
            self._room.name,
            SCREEN_FEEDBACK_INTERVAL_SECONDS,
        )

    async def close(self) -> None:
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
        await self._stop_video()
        logger.info("[JOB:screen-feedback] stopped room=%s", self._room.name)

    def _on_data_received(self, packet: rtc.DataPacket) -> None:
        if packet.topic not in {None, "", SURFACE_STATE_TOPIC}:
            return
        if (
            packet.participant is not None
            and packet.participant.identity != self._participant_identity
        ):
            return
        try:
            payload = json.loads(packet.data.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return
        if not isinstance(payload, dict) or payload.get("type") != "candidate_surface_state":
            return

        surface = payload.get("surface")
        visible = payload.get("visible") is True and surface in SUPPORTED_SURFACES
        revision = payload.get("content_revision")
        if not isinstance(revision, int) or isinstance(revision, bool) or revision < 0:
            revision = 0
        question_id = payload.get("question_id")
        question_text = payload.get("question")
        question_type = payload.get("question_type")
        question = (
            {
                "id": str(question_id),
                "text": str(question_text or ""),
                "questionType": str(question_type or ""),
                "surface": str(surface),
            }
            if visible and question_id
            else None
        )

        changed_surface = (
            not self._surface_visible
            or not visible
            or self._surface != surface
            or self._question is None
            or question is None
            or self._question.get("id") != question.get("id")
        )
        now = time.monotonic()
        self._surface_visible = visible
        self._surface = str(surface) if visible else None
        self._question = question
        if changed_surface:
            self._revision = revision
            self._last_evaluated_revision = revision
            self._stall_evaluated_revision = None
            self._unchanged_since = now
            self._last_feedback = ""
            self._last_spoken_at = 0.0
        elif revision != self._revision:
            self._revision = revision
            self._stall_evaluated_revision = None
            self._unchanged_since = now
        self._sync_subscription()

    def _screen_publication(self) -> rtc.RemoteTrackPublication | None:
        participant = self._room.remote_participants.get(self._participant_identity)
        if participant is None:
            return None
        for publication in participant.track_publications.values():
            if publication.source == rtc.TrackSource.SOURCE_SCREENSHARE:
                return publication
        return None

    def _sync_subscription(self) -> None:
        if not self._started:
            return
        publication = self._screen_publication()
        if publication is None:
            return
        should_subscribe = self._surface_visible and self._question is not None
        if publication.subscribed != should_subscribe:
            publication.set_subscribed(should_subscribe)
        if should_subscribe and publication.track is not None and self._video_stream is None:
            self._start_video(publication.track)

    def _on_track_published(
        self,
        publication: rtc.RemoteTrackPublication,
        participant: rtc.RemoteParticipant,
    ) -> None:
        if (
            participant.identity == self._participant_identity
            and publication.source == rtc.TrackSource.SOURCE_SCREENSHARE
        ):
            self._sync_subscription()

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
            self._start_video(track)

    def _on_track_unsubscribed(
        self,
        _track: rtc.Track,
        publication: rtc.RemoteTrackPublication,
        participant: rtc.RemoteParticipant,
    ) -> None:
        if (
            participant.identity == self._participant_identity
            and publication.source == rtc.TrackSource.SOURCE_SCREENSHARE
        ):
            self._latest_frame = None
            if self._video_task is not None:
                self._video_task.cancel()
                self._video_task = None
            self._video_stream = None

    def _start_video(self, track: rtc.Track) -> None:
        if self._video_task is not None:
            self._video_task.cancel()
        self._video_stream = rtc.VideoStream(track, capacity=1)
        stream = self._video_stream

        async def consume() -> None:
            try:
                async for event in stream:
                    self._latest_frame = event.frame
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Screen-share video stream failed room=%s", self._room.name)

        self._video_task = asyncio.create_task(
            consume(),
            name=f"screen-feedback-video:{self._room.name}",
        )

    async def _stop_video(self) -> None:
        if self._video_task is not None:
            self._video_task.cancel()
            await asyncio.gather(self._video_task, return_exceptions=True)
            self._video_task = None
        if self._video_stream is not None:
            await self._video_stream.aclose()
            self._video_stream = None
        self._latest_frame = None

    def _snapshot(self) -> ScreenSnapshot | None:
        if self._question is None or not self._surface_visible or self._latest_frame is None:
            return None
        return ScreenSnapshot(
            frame=self._latest_frame,
            question=self._question,
            revision=self._revision,
            inactive_seconds=max(0.0, time.monotonic() - self._unchanged_since),
        )

    def _can_evaluate(self) -> bool:
        return bool(
            self._snapshot() is not None
            and self._session is not None
            and self._session.agent_state == "listening"
            and self._session.user_state != "speaking"
        )

    def _snapshot_is_current(self, snapshot: ScreenSnapshot) -> bool:
        return bool(
            self._question is not None
            and self._surface_visible
            and self._question.get("id") == snapshot.question.get("id")
            and self._surface == snapshot.question.get("surface")
            and self._revision == snapshot.revision
        )

    async def _run_timer(self) -> None:
        while True:
            await asyncio.sleep(SCREEN_FEEDBACK_INTERVAL_SECONDS)
            try:
                await self._evaluate()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Screen feedback evaluation failed room=%s", self._room.name)

    async def _evaluate(self) -> None:
        if not self._can_evaluate():
            return
        snapshot = self._snapshot()
        session = self._session
        if snapshot is None or session is None:
            return
        trigger = self._analyzer.trigger(
            snapshot,
            last_evaluated_revision=self._last_evaluated_revision,
            stall_evaluated_revision=self._stall_evaluated_revision,
        )
        if trigger is None:
            return
        async with self._analysis_lock:
            decision = await self._analyzer.analyze(snapshot, trigger, self._last_feedback)
        if not self._snapshot_is_current(snapshot) or not self._can_evaluate():
            return

        self._last_evaluated_revision = snapshot.revision
        if trigger is ScreenFeedbackTrigger.STALL:
            self._stall_evaluated_revision = snapshot.revision
        should_speak = self._analyzer.should_speak(
            decision,
            last_spoken_at=self._last_spoken_at,
        )
        logger.info(
            "Screen feedback decision room=%s question_id=%s trigger=%s should_speak=%s confidence=%.2f",
            self._room.name,
            snapshot.question.get("id"),
            trigger.value,
            should_speak,
            decision.confidence,
        )
        if not should_speak:
            return

        from_line = decision.highlight_from_line
        to_line = decision.highlight_to_line
        if (
            snapshot.question.get("surface") == "code"
            and from_line is not None
            and to_line is not None
            and from_line <= to_line
        ):
            await self._room.local_participant.publish_data(
                json.dumps(
                    {
                        "type": "screen_feedback_highlight",
                        "fromLine": from_line,
                        "toLine": to_line,
                    }
                ).encode("utf-8"),
                reliable=True,
            )

        feedback = decision.feedback.strip()
        session.say(feedback, allow_interruptions=True, add_to_chat_ctx=False)
        self._last_feedback = feedback
        self._last_spoken_at = time.monotonic()
        await self._note_sink(
            "[SCREEN OBSERVER NOTE] A separate visual observer said aloud: "
            f'"{feedback}" This was a work-in-progress nudge, not a submitted answer. '
            f"Question {snapshot.question.get('id')} remains active."
        )
