"""Simulation mode shims for testing."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

logger = logging.getLogger(__name__)


def merge_simulation_userdata(
    simulation_context: Any,
    metadata: dict[str, Any],
) -> dict[str, Any]:
    if simulation_context is None:
        return metadata
    payload = simulation_context.userdata()
    if not isinstance(payload, dict):
        return metadata
    merged = dict(metadata)
    merged.update(payload)
    return merged


async def simulate_submit_active_question(
    tracker: Any,
    *,
    whiteboard_assessment: dict[str, Any] | None = None,
) -> bool:
    question = tracker.active_question
    if question is None:
        return False

    surface = question.get("surface", "verbal")
    question_id = question["id"]

    if surface == "code":
        code_answer = tracker._code_answers.get(question_id)
        if code_answer and code_answer.get("submitted"):
            return False
        tracker.store_code_answer(
            {
                "questionId": question_id,
                "surface": "code",
                "answerMode": "surface",
                "language": question.get("language", "javascript"),
                "code": "function solution() {}",
                "revision": 1,
                "submitted": True,
            },
            participant_identity=tracker._participant_identity,
        )
        if tracker._on_answer_submitted is not None:
            await tracker._on_answer_submitted(question_id)
        return True

    if question.get("questionType") == "mcq":
        options = question.get("options", [])
        answer = question.get("answer", {})
        correct_option = answer.get("correctOption", "")
        option_index = -1
        for i, opt in enumerate(options):
            if opt == correct_option:
                option_index = i
                break
        if option_index < 0:
            return False
        tracker.store_mcq_answer(
            {
                "questionId": question_id,
                "optionIndex": option_index,
                "optionText": correct_option,
                "submitted": True,
            },
            participant_identity=tracker._participant_identity,
        )
        if tracker._on_answer_submitted is not None:
            await tracker._on_answer_submitted(question_id)
        return True

    if surface == "whiteboard":
        if whiteboard_assessment is not None:
            tracker._whiteboards.seed_assessment(question_id, whiteboard_assessment)
        if tracker._on_answer_submitted is not None:
            await tracker._on_answer_submitted(question_id)
        return True

    return False


def install_answer_submit_shim(
    session: Any,
    evidence_tracker: Any,
    metadata: dict[str, Any],
) -> None:
    sim = metadata.get("simulation") if isinstance(metadata, dict) else None
    wb_assessment = (
        sim.get("whiteboard_assessment")
        if isinstance(sim, dict)
        else None
    )

    def _on_item(event: Any) -> None:
        item = event.item
        if not hasattr(item, "role") or item.role != "user":
            return
        loop = asyncio.get_event_loop()
        loop.create_task(
            simulate_submit_active_question(
                evidence_tracker,
                whiteboard_assessment=wb_assessment,
            )
        )

    session.on("conversation_item_added")(_on_item)
