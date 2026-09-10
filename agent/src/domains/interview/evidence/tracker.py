"""Interview evidence tracker for collecting question turns and code."""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Awaitable, Callable
from copy import deepcopy
from typing import Any

from livekit import rtc
from livekit.agents import ChatContext, llm

from domains.interview.questions.store import candidate_safe_question
from domains.interview.whiteboard.evidence import WhiteboardEvidence
from domains.recording.config import RecordingConfig

logger = logging.getLogger(__name__)

CODE_ANSWER_TOPIC = "candidate.code_answer"
MCQ_ANSWER_TOPIC = "candidate.mcq_answer"
MAX_CODE_ANSWER_CHARS = 20_000
ANSWER_DRAIN_TIMEOUT_SECONDS = 1
SUPPORTED_CODE_LANGUAGES = {"java", "javascript", "python", "react"}


def _message_turn(item: object) -> dict[str, str] | None:
    if not isinstance(item, llm.ChatMessage):
        return None
    if item.extra.get("internal_timer") is True:
        return None
    if item.role not in {"assistant", "user"}:
        return None
    text = item.text_content
    if not isinstance(text, str) or not text.strip():
        return None
    return {"role": item.role, "text": text.strip()}


class InterviewEvidenceTracker:
    def __init__(
        self,
        *,
        questions: object,
        participant_identity: str,
        room_name: str = "",
        agent_type: str = "mock-interview-agent",
        recording_config: RecordingConfig | None = None,
        on_answer_submitted: Callable[[str], Awaitable[None]] | None = None,
    ) -> None:
        self._participant_identity = participant_identity
        self._on_answer_submitted = on_answer_submitted
        self._questions: list[dict[str, Any]] = []
        self._questions_by_id: dict[str, dict[str, Any]] = {}
        self._active_question_id: str | None = None
        self._started_question_ids: set[str] = set()
        self._turns: dict[str, list[dict[str, str]]] = {}
        self._code_answers: dict[str, dict[str, Any]] = {}
        self._mcq_answers: dict[str, dict[str, Any]] = {}
        self._stream_tasks: set[asyncio.Task[None]] = set()
        self._room: rtc.Room | None = None
        self._whiteboards = WhiteboardEvidence(
            participant_identity=participant_identity,
            room_name=room_name,
            on_answer_submitted=on_answer_submitted,
        )
        self.load_plan(questions)

    def load_plan(self, questions: object) -> None:
        raw_questions = questions if isinstance(questions, list) else []
        self._questions = [
            deepcopy(question)
            for question in raw_questions
            if isinstance(question, dict)
            and isinstance(question.get("id"), str)
            and isinstance(question.get("text"), str)
        ]
        self._questions_by_id = {
            question["id"]: question for question in self._questions
        }
        self._turns = {question["id"]: [] for question in self._questions}
        self._started_question_ids.clear()
        self._active_question_id = None
        self._code_answers.clear()
        self._mcq_answers.clear()
        self._whiteboards.load_plan(self._questions)

    def start(self, room: rtc.Room) -> None:
        room.register_text_stream_handler(CODE_ANSWER_TOPIC, self._on_code_stream)
        room.register_text_stream_handler(MCQ_ANSWER_TOPIC, self._on_mcq_stream)
        self._whiteboards.start(room)
        self._room = room

    async def close(self) -> None:
        room = self._room
        self._room = None
        if room is not None:
            for topic in (CODE_ANSWER_TOPIC, MCQ_ANSWER_TOPIC):
                try:
                    room.unregister_text_stream_handler(topic)
                except ValueError:
                    pass
        if self._stream_tasks:
            await asyncio.gather(*self._stream_tasks, return_exceptions=True)
            self._stream_tasks.clear()
        await self._whiteboards.close()

    async def wait_for_pending_answers(self) -> None:
        await asyncio.sleep(0.25)
        if self._stream_tasks:
            await asyncio.wait(
                set(self._stream_tasks),
                timeout=ANSWER_DRAIN_TIMEOUT_SECONDS,
            )
        await self._whiteboards.wait_for_pending()

    async def wait_for_pending_code_answers(self) -> None:
        await self.wait_for_pending_answers()

    async def active_whiteboard_assessment(self) -> dict[str, Any] | None:
        await self.wait_for_pending_answers()
        return self._whiteboards.active_assessment()

    def on_question_started(self, question: dict[str, Any]) -> None:
        question_id = question.get("id")
        if not isinstance(question_id, str) or question_id not in self._questions_by_id:
            return
        self._active_question_id = question_id
        self._started_question_ids.add(question_id)
        self._whiteboards.on_question_started(question_id)

    def on_conversation_item(self, item: object) -> None:
        question_id = self._active_question_id
        if question_id is None:
            return
        turn = _message_turn(item)
        if turn is not None:
            self._turns[question_id].append(turn)

    def has_started_final_question(self) -> bool:
        return bool(
            self._questions
            and self._questions[-1]["id"] in self._started_question_ids
        )

    def is_final_question_ready(self) -> bool:
        if not self.has_started_final_question():
            return False
        final_question = self._questions[-1]
        if final_question.get("surface") != "whiteboard":
            return True
        return self._whiteboards.has_accepted(final_question["id"])

    def store_code_answer(
        self,
        payload: object,
        *,
        participant_identity: str,
    ) -> bool:
        if participant_identity != self._participant_identity:
            return False
        if not isinstance(payload, dict):
            return False
        if payload.get("surface") != "code" or payload.get("answerMode") != "surface":
            return False

        question_id = payload.get("questionId")
        question = (
            self._questions_by_id.get(question_id)
            if isinstance(question_id, str)
            else None
        )
        if (
            question is None
            or question.get("surface") != "code"
            or question.get("answerMode") != "surface"
        ):
            return False

        language = payload.get("language")
        code = payload.get("code")
        revision = payload.get("revision")
        submitted = payload.get("submitted")
        if not isinstance(language, str) or language not in SUPPORTED_CODE_LANGUAGES:
            return False
        if not isinstance(code, str) or len(code) > MAX_CODE_ANSWER_CHARS:
            return False
        if not isinstance(revision, int) or isinstance(revision, bool) or revision < 0:
            return False
        if not isinstance(submitted, bool):
            return False

        previous = self._code_answers.get(question_id)
        if previous is not None:
            previous_revision = previous["revision"]
            if revision < previous_revision:
                return False
            if revision == previous_revision and (
                previous["submitted"] or not submitted
            ):
                return False

        self._code_answers[question_id] = {
            "language": language,
            "code": code,
            "revision": revision,
            "submitted": submitted,
        }
        return True

    def store_mcq_answer(
        self,
        payload: object,
        *,
        participant_identity: str,
    ) -> bool:
        if participant_identity != self._participant_identity or not isinstance(
            payload, dict
        ):
            return False

        question_id = payload.get("questionId")
        question = (
            self._questions_by_id.get(question_id)
            if isinstance(question_id, str)
            else None
        )
        if (
            question is None
            or question.get("questionType") != "mcq"
        ):
            return False

        option_index = payload.get("optionIndex")
        option_text = payload.get("optionText")
        submitted = payload.get("submitted")
        options = question.get("options")
        if (
            not isinstance(option_index, int)
            or isinstance(option_index, bool)
            or not isinstance(options, list)
            or option_index < 0
            or option_index >= len(options)
            or not isinstance(option_text, str)
            or options[option_index] != option_text
            or not isinstance(submitted, bool)
        ):
            return False

        previous = self._mcq_answers.get(question_id)
        if previous is not None and previous["submitted"]:
            return False

        answer = question.get("answer")
        if not isinstance(answer, dict):
            return False
        correct_option = answer.get("correctOption")
        explanation = answer.get("explanation")
        if not isinstance(correct_option, str) or not isinstance(explanation, str):
            return False

        self._mcq_answers[question_id] = {
            "optionIndex": option_index,
            "optionText": option_text,
            "submitted": submitted,
            "isCorrect": option_text == correct_option if submitted else None,
            "explanation": explanation if submitted else None,
        }
        return True

    def build_evidence(self) -> list[dict[str, Any]]:
        return [
            {
                **candidate_safe_question(question),
                "turns": list(self._turns[question["id"]]),
                "code_answer": deepcopy(self._code_answers.get(question["id"])),
                "whiteboard_answer": self._whiteboards.evidence_for(question["id"]),
            }
            for question in self._questions
        ]

    def build_mcq_assessments(self) -> dict[str, dict[str, Any]]:
        return {
            question["id"]: deepcopy(
                self._mcq_answers.get(
                    question["id"],
                    {
                        "submitted": False,
                        "isCorrect": None,
                        "explanation": None,
                    },
                )
            )
            for question in self._questions
            if question.get("questionType") == "mcq"
        }

    def _track_stream_task(
        self,
        coroutine: Any,
        *,
        name: str,
    ) -> None:
        task = asyncio.create_task(coroutine, name=name)
        self._stream_tasks.add(task)
        task.add_done_callback(self._stream_tasks.discard)

    def _on_code_stream(
        self,
        reader: rtc.TextStreamReader,
        participant_identity: str,
    ) -> None:
        self._track_stream_task(
            self._consume_stream(reader, participant_identity, kind="code"),
            name="candidate-code-answer",
        )

    def _on_mcq_stream(
        self,
        reader: rtc.TextStreamReader,
        participant_identity: str,
    ) -> None:
        self._track_stream_task(
            self._consume_stream(reader, participant_identity, kind="mcq"),
            name="candidate-mcq-answer",
        )

    async def _consume_stream(
        self,
        reader: rtc.TextStreamReader,
        participant_identity: str,
        *,
        kind: str,
    ) -> None:
        try:
            payload = json.loads(await reader.read_all())
        except (UnicodeDecodeError, json.JSONDecodeError):
            logger.warning("Ignored invalid candidate %s answer payload", kind)
            return
        stored = (
            self.store_code_answer(payload, participant_identity=participant_identity)
            if kind == "code"
            else self.store_mcq_answer(payload, participant_identity=participant_identity)
        )
        if not stored:
            logger.warning("Ignored invalid candidate %s answer", kind)
            return
        if payload.get("submitted") is not True or self._on_answer_submitted is None:
            return
        question_id = payload.get("questionId")
        try:
            await self._on_answer_submitted(question_id)
        except Exception:
            logger.exception(
                "Answer-submitted callback failed question_id=%s kind=%s",
                question_id,
                kind,
            )


def conversation_turns(chat_ctx: ChatContext) -> list[dict[str, str]]:
    turns: list[dict[str, str]] = []
    for item in chat_ctx.items:
        turn = _message_turn(item)
        if turn is not None:
            turns.append(turn)
    return turns
