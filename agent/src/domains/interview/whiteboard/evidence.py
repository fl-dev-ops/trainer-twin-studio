"""Whiteboard evidence collection."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import os
import re
import time
from collections.abc import Awaitable, Callable
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any

from livekit import rtc

logger = logging.getLogger(__name__)
WHITEBOARD_EVALUATION_TOPIC = "candidate.whiteboard_evaluation"
WHITEBOARD_STATUS_TOPIC = "agent.whiteboard_answer_status"
MAX_WHITEBOARD_BYTES = 4 * 1024 * 1024
MAX_ASSESSMENT_CHARS = 12_000
ASSESSMENT_MAX_AGE_SECONDS = 300
STREAM_LOG_PREFIX = "[STREAM:whiteboard]"
_IMAGE_HASH_RE = re.compile(r"^[a-f0-9]{64}$")


class WhiteboardEvidence:
    def __init__(
        self,
        *,
        participant_identity: str,
        room_name: str,
        on_answer_submitted: Callable[[str], Awaitable[None]] | None,
    ) -> None:
        self._participant_identity = participant_identity
        self._room_name = room_name
        self._on_answer_submitted = on_answer_submitted
        self._questions_by_id: dict[str, dict[str, Any]] = {}
        self._active_question_id: str | None = None
        self._answers: dict[str, dict[str, Any]] = {}
        self._room: rtc.Room | None = None
        self._stream_tasks: set[asyncio.Task[None]] = set()

    def load_plan(self, questions: list[dict[str, Any]]) -> None:
        self._questions_by_id = {
            question["id"]: question
            for question in questions
            if isinstance(question.get("id"), str)
        }
        self._active_question_id = None
        self._answers.clear()

    def on_question_started(self, question_id: str) -> None:
        if question_id in self._questions_by_id:
            self._active_question_id = question_id

    def start(self, room: rtc.Room) -> None:
        room.register_text_stream_handler(
            WHITEBOARD_EVALUATION_TOPIC, self._on_evaluation_stream
        )
        self._room = room

    async def close(self) -> None:
        room = self._room
        self._room = None
        if room is not None:
            try:
                room.unregister_text_stream_handler(WHITEBOARD_EVALUATION_TOPIC)
            except ValueError:
                pass
        await self.wait_for_pending()

    async def wait_for_pending(self) -> None:
        if self._stream_tasks:
            await asyncio.gather(*set(self._stream_tasks), return_exceptions=True)

    def evidence_for(self, question_id: str) -> dict[str, Any] | None:
        answer = self._answers.get(question_id)
        if answer is None:
            return None
        evidence: dict[str, Any] = {
            "submitted": True,
            "revision": answer["revision"],
            "evaluation_status": answer["evaluation_status"],
        }
        if isinstance(answer.get("visual_assessment"), dict):
            evidence["visual_assessment"] = deepcopy(answer["visual_assessment"])
        return evidence

    def has_accepted(self, question_id: str) -> bool:
        return question_id in self._answers

    def active_assessment(self) -> dict[str, Any] | None:
        question_id = self._active_question_id
        if question_id is None:
            return None
        answer = self._answers.get(question_id)
        assessment = answer.get("visual_assessment") if answer is not None else None
        if not isinstance(assessment, dict):
            return None
        return {
            "questionId": question_id,
            **deepcopy(assessment),
        }

    def _track_stream(self, coroutine: Any, *, name: str) -> None:
        task = asyncio.create_task(coroutine, name=name)
        self._stream_tasks.add(task)
        task.add_done_callback(self._stream_tasks.discard)

    def _on_evaluation_stream(
        self,
        reader: rtc.TextStreamReader,
        participant_identity: str,
    ) -> None:
        self._track_stream(
            self._consume_evaluation(reader, participant_identity),
            name="candidate-whiteboard-evaluation",
        )

    async def _publish_status(
        self,
        *,
        question_id: str,
        revision: int,
        status: str,
        message: str | None = None,
    ) -> None:
        room = self._room
        if room is None:
            return
        event: dict[str, Any] = {
            "type": "whiteboard_answer_status",
            "questionId": question_id,
            "revision": revision,
            "status": status,
        }
        if message:
            event["message"] = message
        await room.local_participant.publish_data(
            json.dumps(event, separators=(",", ":")).encode(),
            reliable=True,
            destination_identities=[self._participant_identity],
            topic=WHITEBOARD_STATUS_TOPIC,
        )

    async def _reject(self, question_id: str, revision: int, message: str) -> None:
        await self._publish_status(
            question_id=question_id, revision=revision, status="rejected", message=message
        )
        logger.warning(
            "%s rejected question_id=%s revision=%d reason=%s",
            STREAM_LOG_PREFIX,
            question_id,
            revision,
            message,
        )

    async def _accept(
        self,
        question_id: str,
        revision: int,
        visual_assessment: dict[str, Any],
        image_bytes: bytes,
        image_sha256: str,
    ) -> None:
        self._answers[question_id] = {
            "revision": revision,
            "evaluation_status": "accepted",
            "visual_assessment": deepcopy(visual_assessment),
            "image_sha256": image_sha256,
            "_image_bytes": image_bytes,
            "bytes": len(image_bytes),
            "accepted_at": datetime.now(timezone.utc).isoformat(),
            "persistence_status": "pending",
        }
        await self._publish_status(
            question_id=question_id, revision=revision, status="accepted"
        )
        logger.info(
            "%s accepted question_id=%s revision=%d assessment_keys=%s",
            STREAM_LOG_PREFIX,
            question_id,
            revision,
            sorted(visual_assessment.keys()) if visual_assessment else [],
        )
        if self._on_answer_submitted is not None:
            try:
                await self._on_answer_submitted(question_id)
            except Exception:
                logger.exception(
                    "Answer-submitted callback failed question_id=%s", question_id
                )

    async def _consume_evaluation(
        self,
        reader: rtc.TextStreamReader,
        participant_identity: str,
    ) -> None:
        if participant_identity != self._participant_identity:
            return
        try:
            raw = await reader.read_all()
            payload = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError):
            logger.warning("%s invalid payload", STREAM_LOG_PREFIX)
            return
        if not isinstance(payload, dict):
            return

        question_id = payload.get("questionId")
        if not isinstance(question_id, str) or question_id not in self._questions_by_id:
            await self._reject(question_id or "", 0, "Unknown question id")
            return
        if question_id != self._active_question_id:
            await self._reject(question_id, 0, "Question is not active")
            return

        revision = payload.get("revision")
        if not isinstance(revision, int) or isinstance(revision, bool) or revision < 0:
            await self._reject(question_id, 0, "Invalid revision")
            return

        assessment_text = payload.get("visual_assessment")
        if not isinstance(assessment_text, str) or not assessment_text.strip():
            await self._reject(question_id, revision, "Missing visual_assessment")
            return
        if len(assessment_text) > MAX_ASSESSMENT_CHARS:
            await self._reject(question_id, revision, "visual_assessment too long")
            return

        image_data = payload.get("image")
        if not isinstance(image_data, str):
            await self._reject(question_id, revision, "Missing image")
            return

        try:
            image_bytes = bytes.fromhex(image_data)
        except ValueError:
            await self._reject(question_id, revision, "Invalid image hex")
            return
        if len(image_bytes) > MAX_WHITEBOARD_BYTES:
            await self._reject(question_id, revision, "Image too large")
            return

        image_sha256 = hashlib.sha256(image_bytes).hexdigest()
        if not _IMAGE_HASH_RE.match(image_sha256):
            await self._reject(question_id, revision, "Hash computation failed")
            return

        signature = payload.get("signature")
        assessment_hmac = os.getenv("WHITEBOARD_EVALUATION_SIGNING_SECRET", "")
        if assessment_hmac:
            if not isinstance(signature, str) or not signature:
                await self._reject(question_id, revision, "Missing signature")
                return
            expected = hmac.new(
                assessment_hmac.encode(),
                f"{question_id}:{revision}:{image_sha256}".encode(),
                hashlib.sha256,
            ).hexdigest()
            if not hmac.compare_digest(signature, expected):
                await self._reject(question_id, revision, "Invalid signature")
                return

        try:
            visual_assessment = json.loads(assessment_text)
        except json.JSONDecodeError:
            await self._reject(question_id, revision, "Invalid visual_assessment JSON")
            return
        if not isinstance(visual_assessment, dict):
            await self._reject(question_id, revision, "visual_assessment must be an object")
            return

        existing = self._answers.get(question_id)
        if existing is not None and existing["revision"] >= revision:
            await self._reject(question_id, revision, "Stale revision")
            return

        await self._accept(question_id, revision, visual_assessment, image_bytes, image_sha256)
