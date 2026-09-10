"""Interview evaluator and finish tool."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from dataclasses import dataclass
from enum import Enum
from typing import Any

import math
from livekit import rtc
from livekit.agents import (
    Agent,
    ChatContext,
    RunContext,
    StopResponse,
    function_tool,
    llm,
)
from livekit.plugins import openai

from domains.interview.evidence.tracker import (
    InterviewEvidenceTracker,
    conversation_turns,
)
from domains.interview.evaluation.models import (
    AssessmentResult,
    ClosureDecision,
    ClosureRoute,
    CodeResult,
    InterviewEvaluation,
    QuestionAssessment,
    enforce_mcq_assessments,
)

logger = logging.getLogger(__name__)

EVALUATOR_HANDOFF_MESSAGE = "Let me prepare my feedback."
EVALUATOR_ENDING_MESSAGE = (
    "Do you have any questions. If nothing, go ahead and end the call"
)
EVALUATOR_MAX_QUESTION_TURNS = 4
EVALUATOR_OPENROUTER_MODEL = "openai/gpt-4o"
EVALUATION_TIMEOUT_SECONDS = 30


class EvaluatorAgent(Agent):
    def __init__(
        self,
        *,
        chat_ctx: ChatContext,
        evaluator_prompt: str,
        evaluation_payload: dict[str, Any],
        mcq_assessments: dict[str, dict[str, Any]],
    ) -> None:
        self._evaluator_prompt = evaluator_prompt
        self._evaluation_payload = evaluation_payload
        self._mcq_assessments = mcq_assessments
        self._candidate_question_turns = 0
        self._evaluation_task: asyncio.Task[InterviewEvaluation] | None = None
        self._closure_route: ClosureRoute | None = None

        super().__init__(
            instructions=(
                "You have delivered Vasanth's final mock-interview feedback. Answer "
                "only the candidate's questions about that feedback or interview, "
                "concisely and constructively. Allow at most four candidate question "
                "turns. Never end the session, disconnect, delete the room, or claim "
                "that you ended the call. When the candidate has no questions, say "
                f'exactly: "{EVALUATOR_ENDING_MESSAGE}"'
            ),
            tools=[],
            chat_ctx=chat_ctx,
        )

    def attach_pending_evaluation(
        self, task: asyncio.Task[InterviewEvaluation]
    ) -> None:
        self._evaluation_task = task

    async def _await_evaluation(self) -> InterviewEvaluation:
        task = self._evaluation_task
        if task is not None:
            return await task
        return await self._evaluate()

    async def _evaluate(self) -> InterviewEvaluation:
        chat_ctx = ChatContext()
        chat_ctx.add_message(role="system", content=self._evaluator_prompt)
        chat_ctx.add_message(
            role="user",
            content=json.dumps(self._evaluation_payload, ensure_ascii=True),
        )
        llm_client = openai.LLM.with_openrouter(model=EVALUATOR_OPENROUTER_MODEL)
        response = await llm_client.chat(
            chat_ctx=chat_ctx,
            response_format=InterviewEvaluation,
        ).collect()
        return InterviewEvaluation.model_validate_json(response.text)

    async def on_enter(self) -> None:
        try:
            evaluation = await asyncio.wait_for(
                self._await_evaluation(),
                timeout=EVALUATION_TIMEOUT_SECONDS,
            )
            enforce_mcq_assessments(evaluation, self._mcq_assessments)
            decision = decide_closure(
                self._evaluation_payload["planned_questions"],
                evaluation,
                locally_usable_question_ids={
                    question_id
                    for question_id, assessment in self._mcq_assessments.items()
                    if assessment.get("submitted") is True
                },
            )
            closure = render_vasanth_closure(decision, evaluation)
        except Exception:
            logger.exception("Interview evaluation failed")
            closure = render_evaluation_failure()

        speech_handle = self.session.say(
            closure,
            allow_interruptions=False,
            add_to_chat_ctx=True,
        )
        await speech_handle

    async def on_exit(self) -> None:
        task = self._evaluation_task
        if task is not None and not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        await super().on_exit()

    async def on_user_turn_completed(
        self,
        turn_ctx: ChatContext,
        new_message: llm.ChatMessage,
    ) -> None:
        self._candidate_question_turns += 1
        if self._candidate_question_turns > EVALUATOR_MAX_QUESTION_TURNS:
            await self.session.say(
                EVALUATOR_ENDING_MESSAGE,
                allow_interruptions=False,
                add_to_chat_ctx=True,
            )
            raise StopResponse()

        if self._candidate_question_turns == EVALUATOR_MAX_QUESTION_TURNS:
            turn_ctx.add_message(
                role="developer",
                content=(
                    "This is the fourth and final evaluator question turn. Answer the "
                    "candidate's current question briefly, then end exactly with: "
                    f'"{EVALUATOR_ENDING_MESSAGE}" Never ask another question.'
                ),
            )
            return

        turn_ctx.add_message(
            role="developer",
            content=(
                "Answer the candidate's current interview-feedback question briefly. "
                "If they indicate they have no questions, reply exactly with: "
                f'"{EVALUATOR_ENDING_MESSAGE}" Otherwise ask only whether they have '
                "another question. Never end or disconnect the session."
            ),
        )


def build_finish_interview_tool(
    *,
    tracker: InterviewEvidenceTracker,
    evaluator_prompt: str,
    candidate_context: dict[str, Any],
):
    @function_tool(
        name="finish_interview",
        description=(
            "Required evaluator handoff after the candidate completes the final "
            "planned question and every required probe or walkthrough. A final "
            "Whiteboard question is not complete until the candidate answers both "
            "required follow-ups. Continue normal "
            "clarification and guidance while the final answer is still active; then "
            "follow the system prompt's acknowledgement rule and call this immediately "
            "in the same turn. Do not first announce that the interview is done, "
            "summarize, score, thank the candidate, or wait for another candidate "
            "message. The tool says 'Let me prepare my feedback.' and then hands the "
            "completed interview to Vasanth's "
            "evaluator for feedback and up to four candidate question turns. It never "
            "ends the room; the candidate ends the call. Set session_inconclusive to true only when "
            "time expired or the candidate could not continue before the final "
            "planned question."
        ),
    )
    async def finish_interview(
        context: RunContext,
        session_inconclusive: bool = False,
    ) -> Agent | dict[str, str]:
        final_question_ready = (
            tracker.is_final_question_ready()
            if hasattr(tracker, "is_final_question_ready")
            else tracker.has_started_final_question()
        )
        if not session_inconclusive and not final_question_ready:
            return {
                "status": "not_ready",
                "message": (
                    "The final planned question has not started or its required "
                    "whiteboard image has not been accepted. Continue the interview "
                    "before requesting evaluation."
                ),
            }

        current_agent = context.session.current_agent
        if current_agent is None:
            return {
                "status": "unavailable",
                "message": "The interviewer context is unavailable.",
            }
        await tracker.wait_for_pending_code_answers()
        evaluator_chat_ctx = current_agent.chat_ctx.copy(
            exclude_instructions=True,
            exclude_function_call=True,
            exclude_empty_message=True,
            exclude_handoff=True,
            exclude_config_update=True,
        )
        evaluation_payload = {
            "candidate_context": candidate_context,
            "conversation": conversation_turns(evaluator_chat_ctx),
            "planned_questions": tracker.build_evidence(),
        }
        evaluator = EvaluatorAgent(
            chat_ctx=evaluator_chat_ctx,
            evaluator_prompt=evaluator_prompt,
            evaluation_payload=evaluation_payload,
            mcq_assessments=(
                tracker.build_mcq_assessments()
                if hasattr(tracker, "build_mcq_assessments")
                else {}
            ),
        )
        evaluation_task = asyncio.create_task(
            evaluator._evaluate(),
            name="interview-evaluation",
        )
        evaluator.attach_pending_evaluation(evaluation_task)
        try:
            await context.session.say(
                EVALUATOR_HANDOFF_MESSAGE,
                allow_interruptions=False,
                add_to_chat_ctx=True,
            )
        except BaseException:
            evaluation_task.cancel()
            raise
        return evaluator

    return finish_interview


def _has_usable_answer(question: dict[str, Any]) -> bool:
    turns = question.get("turns")
    if isinstance(turns, list):
        for turn in turns:
            if (
                isinstance(turn, dict)
                and turn.get("role") == "user"
                and isinstance(turn.get("text"), str)
                and turn["text"].strip()
            ):
                return True
    whiteboard_answer = question.get("whiteboard_answer")
    if (
        isinstance(whiteboard_answer, dict)
        and isinstance(whiteboard_answer.get("visual_assessment"), dict)
    ):
        return True
    code_answer = question.get("code_answer")
    return bool(
        isinstance(code_answer, dict)
        and isinstance(code_answer.get("code"), str)
        and code_answer["code"].strip()
    )


def decide_closure(
    evidence: list[dict[str, Any]],
    evaluation: InterviewEvaluation,
    locally_usable_question_ids: set[str] | None = None,
) -> ClosureDecision:
    if not evidence:
        return ClosureDecision(ClosureRoute.FEEDBACK_ONLY)

    expected_ids = [question["id"] for question in evidence]
    assessment_ids = [assessment.question_id for assessment in evaluation.assessments]
    local_ids = locally_usable_question_ids or set()
    usable_ratio = sum(
        _has_usable_answer(question) or question["id"] in local_ids
        for question in evidence
    ) / len(evidence)
    if (
        usable_ratio < 0.5
        or evaluation.confidence < 0.6
        or len(set(assessment_ids)) != len(assessment_ids)
        or set(assessment_ids) != set(expected_ids)
    ):
        return ClosureDecision(ClosureRoute.FEEDBACK_ONLY)

    by_id = {
        assessment.question_id: assessment for assessment in evaluation.assessments
    }
    assessments = [by_id[question_id] for question_id in expected_ids]
    correct_count = sum(
        assessment.result is AssessmentResult.CORRECT for assessment in assessments
    )
    partial_count = sum(
        assessment.result is AssessmentResult.PARTIAL for assessment in assessments
    )
    failed_count = sum(
        assessment.result
        in {AssessmentResult.INCORRECT, AssessmentResult.NOT_ATTEMPTED}
        for assessment in assessments
    )
    fundamental_misses = sum(
        assessment.is_fundamental
        and assessment.result
        in {AssessmentResult.INCORRECT, AssessmentResult.NOT_ATTEMPTED}
        for assessment in assessments
    )

    written_code_is_strong = all(
        _has_usable_answer(question)
        and by_id[question["id"]].code_result is CodeResult.SUBSTANTIALLY_CORRECT
        for question in evidence
        if question.get("surface") == "code" and question.get("answerMode") == "surface"
    )
    accept = (
        correct_count / len(assessments) >= 0.8
        and fundamental_misses == 0
        and written_code_is_strong
    )
    if accept:
        return ClosureDecision(ClosureRoute.ACCEPT)

    if failed_count / len(assessments) >= 0.5 or fundamental_misses >= 2:
        return ClosureDecision(ClosureRoute.REJECT)

    raw_rating = 5 * (correct_count + 0.5 * partial_count) / len(assessments)
    rating = math.floor(raw_rating * 2 + 0.5) / 2
    return ClosureDecision(ClosureRoute.MIXED, rating=rating)


def _as_sentence(value: str) -> str:
    text = value.strip()
    if not text:
        return ""
    return text if text.endswith((".", "!", "?")) else f"{text}."


def _rating_words(value: float) -> str:
    labels = {
        0.0: "zero",
        0.5: "zero point five",
        1.0: "one",
        1.5: "one point five",
        2.0: "two",
        2.5: "two point five",
        3.0: "three",
        3.5: "three point five",
        4.0: "four",
        4.5: "four point five",
        5.0: "five",
    }
    return labels.get(value, f"{value:g}")


def render_vasanth_closure(
    decision: ClosureDecision,
    evaluation: InterviewEvaluation,
) -> str:
    strength = _as_sentence(evaluation.strengths[0])
    gap = _as_sentence(evaluation.gaps[0]) if evaluation.gaps else ""
    improvement = _as_sentence(evaluation.improvement_direction)
    calibration = (
        _as_sentence(evaluation.experience_calibration)
        if evaluation.experience_calibration
        else ""
    )

    if decision.route is ClosureRoute.ACCEPT:
        parts = [
            "Okay. Sure. So I'll just pass on my honest feedback.",
            strength,
        ]
        if gap:
            parts.extend(
                [
                    gap,
                    "Your answer was not wrong, but you can add more depth there.",
                ]
            )
        parts.extend(
            [
                "Overall, it was a clean interview.",
                "If I were interviewing you, I would definitely select you.",
                "You should be able to clear the interview with the preparation you have shown.",
                EVALUATOR_ENDING_MESSAGE,
            ]
        )
        return " ".join(part for part in parts if part)

    if decision.route is ClosureRoute.REJECT:
        return " ".join(
            part
            for part in [
                "Okay. I'll just pass on my honest feedback.",
                strength,
                gap,
                "I was expecting more.",
                calibration,
                improvement,
                EVALUATOR_ENDING_MESSAGE,
            ]
            if part
        )

    if decision.route is ClosureRoute.MIXED:
        rating = _rating_words(decision.rating or 0)
        return " ".join(
            part
            for part in [
                "Okay, I'll give my honest feedback now.",
                strength,
                gap,
                f"Out of five, I would rate this interview around {rating}.",
                "For me to select you, the minimum I would expect is around three to five.",
                improvement,
                EVALUATOR_ENDING_MESSAGE,
            ]
            if part
        )

    return " ".join(
        part
        for part in [
            "Okay, considering the time, I'll give my honest feedback.",
            strength,
            gap,
            improvement,
            "I don't want to force a verdict from an incomplete session.",
            EVALUATOR_ENDING_MESSAGE,
        ]
        if part
    )


def render_evaluation_failure() -> str:
    return (
        "Okay, considering the time, I'll give my honest feedback. "
        "I don't have enough reliable evidence to give you a fair verdict today, "
        f"so I don't want to force one. {EVALUATOR_ENDING_MESSAGE}"
    )
