"""Question store for interview plan management."""

from __future__ import annotations

from copy import deepcopy
from enum import Enum
from threading import RLock
from typing import Any

SUPPORTED_LANGUAGES = ("html", "java", "javascript", "python", "react")
SUPPORTED_SURFACES = ("verbal", "code", "choice", "whiteboard")


class InterviewPhase(str, Enum):
    INTRODUCTION = "INTRODUCTION"
    INTERVIEW_QUESTIONS = "INTERVIEW_QUESTIONS"
    EVALUATION = "EVALUATION"
    CONCLUSION = "CONCLUSION"


class QuestionStoreError(ValueError):
    def __init__(self, status: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


def candidate_safe_question(question: dict[str, Any]) -> dict[str, Any]:
    safe = {
        key: deepcopy(value)
        for key, value in question.items()
        if key
        in {
            "id",
            "text",
            "spokenText",
            "questionType",
            "responseMode",
            "surface",
            "answerMode",
            "difficulty",
            "domain",
            "topics",
            "options",
            "language",
            "starterCode",
        }
    }
    return {key: value for key, value in safe.items() if value not in (None, "")}


def normalize_supplied_questions(records: object) -> list[dict[str, Any]]:
    if not isinstance(records, list):
        return []
    normalized: list[dict[str, Any]] = []
    for record in records:
        if not isinstance(record, dict):
            continue
        question_id = record.get("id")
        text = record.get("text") or record.get("question")
        if not isinstance(question_id, str) or not question_id.strip():
            continue
        if not isinstance(text, str) or not text.strip():
            continue
        surface = str(record.get("surface") or "verbal").strip().lower()
        if surface not in SUPPORTED_SURFACES:
            surface = "verbal"
        answer_mode = str(record.get("answerMode") or "").strip().lower()
        if answer_mode not in {"verbal", "surface"}:
            answer_mode = "verbal" if surface == "verbal" else "surface"
        question_type = str(record.get("questionType") or "").strip().lower()
        if not question_type:
            if surface == "choice":
                question_type = "mcq"
            elif surface == "whiteboard":
                question_type = "whiteboard"
            elif surface == "code" and answer_mode == "verbal":
                question_type = "code-output"
            elif surface == "code":
                question_type = "coding"
            else:
                question_type = "verbal"
        options = record.get("options")
        answer = record.get("answer")
        if question_type == "mcq":
            if not isinstance(options, list) or not isinstance(answer, dict):
                continue
            correct_option = answer.get("correctOption")
            explanation = answer.get("explanation")
            if (
                not isinstance(correct_option, str)
                or options.count(correct_option) != 1
                or not isinstance(explanation, str)
                or not explanation.strip()
            ):
                continue
        question = {
            "id": question_id.strip(),
            "text": text.strip(),
            "spokenText": str(record.get("spokenText") or text).strip(),
            "questionType": question_type,
            "responseMode": str(
                record.get("responseMode")
                or ("choice" if question_type == "mcq" else answer_mode)
            ),
            "surface": surface,
            "answerMode": answer_mode,
            "difficulty": str(record.get("difficulty") or ""),
            "domain": deepcopy(record.get("domain") or []),
            "topics": deepcopy(record.get("topics") or []),
        }
        for optional in ("options", "language", "starterCode"):
            if optional in record:
                question[optional] = deepcopy(record[optional])
        if question_type == "mcq":
            question["answer"] = deepcopy(answer)
        normalized.append(question)
    return normalized


class QuestionStore:
    def __init__(self) -> None:
        self._questions: list[dict[str, Any]] = []
        self._by_id: dict[str, dict[str, Any]] = {}
        self._next_index = 0
        self._last_started_id: str | None = None
        self._started_ids: set[str] = set()
        self._submitted_ids: set[str] = set()
        self._skipped_ids: set[str] = set()
        self._reserved_indexes: dict[str, int] = {}
        self._delivery_failed_ids: set[str] = set()
        self._initialized = False
        self._phase = InterviewPhase.INTRODUCTION
        self._lock = RLock()

    def load(self, questions: list[dict[str, Any]]) -> None:
        copied = deepcopy(questions)
        ids = [question.get("id") for question in copied]
        if any(not isinstance(question_id, str) or not question_id for question_id in ids):
            raise ValueError("Every planned question must have a non-empty id")
        if len(ids) != len(set(ids)):
            raise ValueError("Planned question ids must be unique")
        with self._lock:
            if self._initialized:
                raise ValueError("The interview plan is already initialized")
            self._questions = copied
            self._by_id = {question["id"]: question for question in copied}
            self._initialized = True

    @property
    def phase(self) -> InterviewPhase:
        with self._lock:
            return self._phase

    def transition_phase(self, new_phase: InterviewPhase) -> None:
        with self._lock:
            self._phase = new_phase

    def is_initialized(self) -> bool:
        with self._lock:
            return self._initialized

    def internal_questions(self) -> list[dict[str, Any]]:
        with self._lock:
            return deepcopy(self._questions)

    def public_plan(self) -> list[dict[str, Any]]:
        with self._lock:
            return [candidate_safe_question(question) for question in self._questions]

    def reserve_next(
        self,
        question_id: str,
        *,
        previous_question_abandoned: bool = False,
    ) -> dict[str, Any]:
        identifier = question_id.strip() if isinstance(question_id, str) else ""
        with self._lock:
            if not identifier or identifier not in self._by_id:
                raise QuestionStoreError(
                    "not_found",
                    "Question id was not found in the active interview plan.",
                )
            if identifier in self._started_ids:
                raise QuestionStoreError(
                    "already_started",
                    "This question has already started. Continue with the candidate's answer.",
                )
            if identifier in self._reserved_indexes:
                raise QuestionStoreError(
                    "already_starting",
                    "This question is already being presented.",
                )
            if identifier in self._delivery_failed_ids:
                raise QuestionStoreError(
                    "delivery_failed",
                    "This question could not be delivered and cannot be started again.",
                )
            if self._next_index >= len(self._questions):
                raise QuestionStoreError(
                    "plan_complete",
                    "All planned questions have already started.",
                )
            index = self._index_of(identifier)
            if index < self._next_index:
                expected = self._questions[self._next_index]
                raise QuestionStoreError(
                    "out_of_order",
                    f"Start the next planned question using id {expected['id']}.",
                )
            if not previous_question_abandoned and self._last_started_id is not None:
                previous = self._by_id[self._last_started_id]
                if (
                    previous.get("surface") in {"code", "choice", "whiteboard"}
                    and previous.get("answerMode") == "surface"
                    and previous["id"] not in self._submitted_ids
                ):
                    raise QuestionStoreError(
                        "answer_pending",
                        "The previous written question has no submitted answer yet. Ask "
                        "the candidate whether they have finished and submitted it, and "
                        "have them walk through it. Only if they cannot finish, call "
                        "start_question again with previous_question_abandoned set to true.",
                    )
            self._reserved_indexes[identifier] = index
            return deepcopy(self._questions[index])

    def _index_of(self, question_id: str) -> int:
        for index, question in enumerate(self._questions):
            if question["id"] == question_id:
                return index
        raise QuestionStoreError(
            "not_found",
            "Question id was not found in the active interview plan.",
        )

    def mark_started(self, question_id: str) -> None:
        with self._lock:
            index = self._reserved_indexes.pop(question_id, None)
            if index is None:
                raise ValueError("Question must be reserved before it is started")
            for passed_over in self._questions[self._next_index : index]:
                self._skipped_ids.add(passed_over["id"])
            self._started_ids.add(question_id)
            self._last_started_id = question_id
            self._next_index = index + 1

    def mark_answer_submitted(self, question_id: str) -> None:
        with self._lock:
            if question_id in self._started_ids:
                self._submitted_ids.add(question_id)

    def mark_delivery_failed(self, question_id: str) -> None:
        with self._lock:
            self._reserved_indexes.pop(question_id, None)
            self._delivery_failed_ids.add(question_id)

    def has_started_final_question(self) -> bool:
        with self._lock:
            return bool(
                self._questions and self._questions[-1]["id"] in self._started_ids
            )
