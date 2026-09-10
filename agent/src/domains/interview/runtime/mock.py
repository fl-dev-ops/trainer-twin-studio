"""Mock Interview adapter preserving the existing LiveKit behavior."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from infrastructure.prompt import build_prompt_context
from services.agent.unified import UnifiedAgent

from .factory import InterviewRuntimeError, RuntimeServices
from .models import InterviewType, ResolvedInterview


class MockInterviewRuntime:
    """Route the current prompt, tools, evaluator, and screen behavior unchanged."""

    content_tracing_enabled = True
    accepts_frontend_questions = True
    uses_mock_pipeline = True
    parallel_tool_calls_enabled = True

    def __init__(self, *, resolved: ResolvedInterview | None, profile: Any) -> None:
        if (
            resolved is not None
            and resolved.request.type is not InterviewType.MOCK_INTERVIEW
        ):
            raise InterviewRuntimeError("Mock adapter received a non-Mock interview")
        self.resolved = resolved
        self._profile = profile
        self.uses_editor_events = bool(profile.editor_events_enabled)
        if resolved is None:
            self.prompt_url = profile.prompt_url
            self.initial_reply = profile.initial_reply
        else:
            self.prompt_url = resolved.definition.prompt_url
            self.initial_reply = resolved.definition.scripts["initial_reply"]

    async def prepare(self) -> None:
        return None

    def build_prompt_context(
        self, metadata: Mapping[str, object]
    ) -> dict[str, str]:
        return build_prompt_context(metadata)

    def build_tools(self, services: RuntimeServices) -> list[Any]:
        from app.tools import build_interview_tools, build_screen_tools

        tools: list[Any] = []
        if self._profile.editor_events_enabled:
            tools.extend(
                build_interview_tools(
                    ctx=services.ctx,
                    question_store=services.question_store,
                    participant_identity=services.participant_identity,
                    evidence_tracker=services.evidence_tracker,
                    evaluator_prompt=services.evaluator_prompt,
                    prompt_context=services.prompt_context,
                    userdata=services.userdata,
                    on_question_started=services.on_question_started,
                    on_plan_loaded=services.on_plan_loaded,
                )
            )
        if (
            services.screen_feedback is not None
            and services.screen_inspection_enabled
        ):
            tools.extend(build_screen_tools(services.screen_feedback))
        return tools

    def build_agent(
        self,
        *,
        instructions: str,
        tools: list[Any],
        prompt_context: Mapping[str, str],
        participant_identity: str,
        room_name: str,
    ) -> UnifiedAgent:
        del prompt_context
        return UnifiedAgent(
            instructions=instructions,
            tools=tools,
            initial_reply=self.initial_reply,
            participant_identity=participant_identity,
            room_name=room_name,
        )

    def on_conversation_item(self, item: object) -> None:
        del item

    def report(self) -> dict[str, object] | None:
        return None
