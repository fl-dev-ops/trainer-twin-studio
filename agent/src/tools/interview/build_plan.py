from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from copy import deepcopy
from typing import Any

from livekit.agents import RunContext, function_tool

from domains.interview.chroma.repository import LOG_PREFIX, build_plan
from domains.interview.config import BUCKET_ORDER, QUESTION_TYPE_BUCKET
from domains.interview.questions.store import QuestionStore

logger = logging.getLogger(__name__)

TECHNICAL_INCONCLUSIVE_MESSAGE = (
    "I'm sorry, but the technical question set is unavailable right now, so I "
    "can't conduct a fair interview. Please go ahead and end the call."
)

PlanLoadedCallback = Callable[[list[dict[str, Any]]], None]


def build_interview_plan_tool(
    *,
    get_collection: Callable[[], Any],
    question_store: QuestionStore,
    on_plan_loaded: PlanLoadedCallback | None,
):
    """Build a deterministic plan without model improvisation."""
    plan_lock = asyncio.Lock()
    cached_result: dict[str, object] | None = None

    async def report_inconclusive(context: RunContext, status: str) -> dict[str, str]:
        speech_handle = context.session.say(
            TECHNICAL_INCONCLUSIVE_MESSAGE,
            allow_interruptions=False,
            add_to_chat_ctx=True,
        )
        await speech_handle
        return {"status": status}

    @function_tool(
        name="build_interview_plan",
        description=(
            "Build the interview plan from the question bank once the candidate's "
            "experience and primary technologies are known. Pass years_experience, "
            "domains such as [\"react\", \"javascript\"], and a focus summary that "
            "contains no candidate name. If successful, start every returned id in "
            "order using start_question. Never invent or substitute a question."
        ),
    )
    async def build_interview_plan(
        context: RunContext,
        years_experience: int,
        domains: list[str] | None = None,
        focus: str = "",
    ) -> dict[str, object]:
        nonlocal cached_result
        async with plan_lock:
            if cached_result is not None:
                return deepcopy(cached_result)
            if question_store.is_initialized():
                questions = question_store.public_plan()
                cached_result = {
                    "status": "ok",
                    "source": "supplied",
                    "questions": [
                        {
                            "id": question["id"],
                            "type": question["questionType"],
                            "surface": question["surface"],
                            "answer_mode": question["answerMode"],
                        }
                        for question in questions
                    ],
                    "message": "The supplied plan is already active. Start it in order by id.",
                }
                return deepcopy(cached_result)

            last_status = "error"
            for attempt in range(2):
                try:
                    collection = get_collection()
                    band, counts, ordered = await asyncio.to_thread(
                        build_plan,
                        collection,
                        years_experience=years_experience,
                        domains=domains,
                        focus=focus,
                    )
                except Exception:
                    logger.exception(
                        "%s plan attempt=%d failed",
                        LOG_PREFIX,
                        attempt + 1,
                    )
                    last_status = "error"
                    continue
                if ordered:
                    break
                logger.warning(
                    "%s plan attempt=%d returned no questions",
                    LOG_PREFIX,
                    attempt + 1,
                )
                last_status = "empty"
            else:
                cached_result = {"status": last_status}
                return await report_inconclusive(context, last_status)

            question_store.load(ordered)
            if on_plan_loaded is not None:
                on_plan_loaded(question_store.internal_questions())

            got = {bucket: 0 for bucket in BUCKET_ORDER}
            type_counts: dict[str, int] = {}
            for question in ordered:
                question_type = question["questionType"]
                type_counts[question_type] = type_counts.get(question_type, 0) + 1
                if question.get("surface") == "whiteboard":
                    got["system-design"] += 1
                else:
                    got[QUESTION_TYPE_BUCKET[question_type]] += 1

            logger.info(
                "%s plan band=%s target=%s got=%s types=%s total=%d",
                LOG_PREFIX,
                band,
                counts,
                got,
                type_counts,
                len(ordered),
            )
            cached_result = {
                "status": "ok",
                "experience_band": band,
                "counts": got,
                "questions": [
                    {
                        "id": question["id"],
                        "type": question["questionType"],
                        "surface": question["surface"],
                        "answer_mode": question["answerMode"],
                    }
                    for question in ordered
                ],
                "message": "Plan ready. Start every returned question in order by id.",
            }
            return deepcopy(cached_result)

    return build_interview_plan
