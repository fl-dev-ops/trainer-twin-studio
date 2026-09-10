"""Resume question LLM tool adapters delegating to the domain controller."""

from __future__ import annotations

from typing import Any

from livekit.agents import RunContext, function_tool

from domains.interview.resume import ResumeQuestionController


def build_resume_question_tools(
    controller: ResumeQuestionController,
) -> list[Any]:
    @function_tool(
        name="start_resume_question",
        description=(
            "Validate, highlight, and speak exactly one new Resume main question. "
            "Use the selected round, an angle unused for the primary claim, eligible "
            "claim IDs, and a single question of at most five hundred characters. "
            "Complete the configured main-question count for the current primary "
            "claim before selecting a new primary claim. For every main after the "
            "first, open only with the neutral bridge 'Okay.' or 'Got it.' without "
            "restating, praising, or evaluating the completed answer."
        ),
    )
    async def start_resume_question(
        context: RunContext,
        round_id: str,
        angle_id: str,
        primary_claim_id: str,
        related_claim_ids: list[str],
        question: str,
    ) -> dict[str, object]:
        return await controller.start_main(
            context,
            round_id=round_id,
            angle_id=angle_id,
            primary_claim_id=primary_claim_id,
            related_claim_ids=related_claim_ids,
            question=question,
        )

    @function_tool(
        name="present_pending_resume_question",
        description=(
            "Resolve a verified-not-found pending main. Pass true only after the "
            "candidate locates it to speak the exact saved question. Pass false when "
            "they cannot locate it; the runtime cancels it and requires another claim."
        ),
    )
    async def present_pending_resume_question(context: RunContext, candidate_located: bool) -> dict[str, object]:
        return await controller.present_pending(context, candidate_located=candidate_located)

    @function_tool(
        name="ask_resume_follow_up",
        description=(
            "Speak one response-grounded follow-up on the active main claim after the "
            "candidate's latest answer. This counts against "
            "max_follow_ups_per_main."
        ),
    )
    async def ask_resume_follow_up(context: RunContext, question: str) -> dict[str, object]:
        return await controller.ask_follow_up(context, question=question)

    @function_tool(
        name="finish_resume_mastery",
        description=(
            "After every configured section and its main questions are complete with "
            "no pending response, "
            "optionally speak one short answer-grounded acknowledgement of the final "
            "answer passed as transition, then speak the fixed closing once and end "
            "the room without scoring. The transition is never a question."
        ),
    )
    async def finish_resume_mastery(
        context: RunContext, transition: str | None = None
    ) -> dict[str, object]:
        return await controller.finish(context, transition=transition)

    return [
        start_resume_question,
        ask_resume_follow_up,
        present_pending_resume_question,
        finish_resume_mastery,
    ]
