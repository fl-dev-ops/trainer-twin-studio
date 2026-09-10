"""Tool building for interview and screen feedback."""

from __future__ import annotations

import logging
from typing import Any

from livekit import agents, rtc
from livekit.agents.beta.tools import EndCallTool

from domains.screen import ScreenFeedbackRuntime, build_screen_inspection_tool
from domains.interview.chroma.repository import chroma_configured, get_cached_collection
from domains.interview.evidence.tracker import InterviewEvidenceTracker
from domains.interview.questions.store import QuestionStore
from domains.interview.evaluation import build_finish_interview_tool
from tools.interview.build_plan import build_interview_plan_tool
from tools.interview.code_highlight import build_code_highlight_tools
from tools.interview.runtime_tools import build_runtime_tools
from tools.interview.start_question import build_start_question_tool
from tools.interview.whiteboard_highlight import build_whiteboard_highlight_tools

from .config import END_CALL_EXTRA_DESCRIPTION, END_CALL_INSTRUCTIONS

logger = logging.getLogger("intervoo_agent")


def build_end_call_tool() -> EndCallTool:
    return EndCallTool(
        extra_description=END_CALL_EXTRA_DESCRIPTION,
        delete_room=True,
        end_instructions=END_CALL_INSTRUCTIONS,
    )


def build_interview_tools(
    *,
    ctx: agents.JobContext,
    question_store: QuestionStore,
    participant_identity: str,
    evidence_tracker: InterviewEvidenceTracker | None,
    evaluator_prompt: str | None,
    prompt_context: dict[str, str],
    userdata: Any,
    on_question_started: Any,
    on_plan_loaded: Any,
) -> list[Any]:
    tools: list[Any] = []

    tools.extend(
        build_runtime_tools(
            room=ctx.room,
            participant_identity=participant_identity,
        )
    )
    tools.append(
        build_start_question_tool(
            room=ctx.room,
            question_store=question_store,
            on_question_started=on_question_started,
        )
    )
    tools.extend(
        build_code_highlight_tools(
            room=ctx.room,
            participant_identity=participant_identity,
        )
    )
    if evidence_tracker is not None:
        tools.extend(
            build_whiteboard_highlight_tools(
                room=ctx.room,
                participant_identity=participant_identity,
                read_assessment=evidence_tracker.active_whiteboard_assessment,
            )
        )

    if chroma_configured():
        tools.append(
            build_interview_plan_tool(
                get_collection=lambda: get_cached_collection(userdata),
                question_store=question_store,
                on_plan_loaded=on_plan_loaded,
            )
        )
    else:
        logger.warning(
            "Chroma is not configured; build_interview_plan tool is unavailable"
        )

    if evidence_tracker is not None and evaluator_prompt is not None:
        tools.append(
            build_finish_interview_tool(
                tracker=evidence_tracker,
                evaluator_prompt=evaluator_prompt,
                candidate_context=dict(prompt_context),
            )
        )

    return tools


from tools.screen.inspect_screen import build_resume_inspection_tool

def build_screen_tools(
    screen_feedback: ScreenFeedbackRuntime,
) -> list[Any]:
    return [
        build_screen_inspection_tool(screen_feedback),
        build_resume_inspection_tool(screen_feedback),
    ]
