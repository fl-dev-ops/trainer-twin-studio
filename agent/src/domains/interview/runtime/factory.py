"""Generic interview runtime protocol and mode factory."""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any, Protocol

from .models import InterviewType, ResolvedInterview

logger = logging.getLogger(__name__)

_SDK_CONTENT_FIELDS = frozenset(
    {
        "arguments",
        "content",
        "event",
        "input",
        "messages",
        "output",
        "raw_arguments",
        "repaired",
        "request",
        "response",
        "result",
        "text",
        "transcript",
        "user_input",
    }
)


class _SdkContentFilter(logging.Filter):
    """Drop SDK records carrying model, tool, or transcript content fields."""

    def filter(self, record: logging.LogRecord) -> bool:
        return not any(field in record.__dict__ for field in _SDK_CONTENT_FIELDS)


_SDK_CONTENT_FILTER = _SdkContentFilter()


def _configure_sdk_content_logging(*, enabled: bool) -> None:
    sdk_logger = logging.getLogger("livekit.agents")
    if enabled:
        sdk_logger.removeFilter(_SDK_CONTENT_FILTER)
    elif _SDK_CONTENT_FILTER not in sdk_logger.filters:
        sdk_logger.addFilter(_SDK_CONTENT_FILTER)


class InterviewRuntimeError(ValueError):
    """Raised when a resolved interview cannot be prepared safely."""


@dataclass(frozen=True)
class RuntimeServices:
    """Live session dependencies supplied after participant resolution."""

    ctx: Any
    participant_identity: str
    question_store: Any
    evidence_tracker: Any
    evaluator_prompt: str | None
    prompt_context: dict[str, str]
    userdata: Any
    on_question_started: Any
    on_plan_loaded: Any
    screen_feedback: Any
    screen_inspection_enabled: bool
    close_room: Callable[[], Awaitable[None]]
    shutdown_job: Callable[[], None]


class InterviewRuntime(Protocol):
    """Mode-neutral contract used by the LiveKit lifecycle."""

    resolved: ResolvedInterview | None
    prompt_url: str
    initial_reply: str
    content_tracing_enabled: bool
    accepts_frontend_questions: bool
    uses_mock_pipeline: bool
    uses_editor_events: bool
    parallel_tool_calls_enabled: bool

    async def prepare(self) -> None: ...

    def build_prompt_context(
        self, metadata: Mapping[str, object]
    ) -> dict[str, str]: ...

    def build_tools(self, services: RuntimeServices) -> list[Any]: ...

    def build_agent(
        self,
        *,
        instructions: str,
        tools: list[Any],
        prompt_context: Mapping[str, str],
        participant_identity: str,
        room_name: str,
    ) -> Any: ...

    def on_conversation_item(self, item: object) -> None: ...

    def report(self) -> dict[str, object] | None: ...


def create_interview_runtime(
    *,
    resolved: ResolvedInterview | None,
    profile: Any,
    metadata: Mapping[str, object],
) -> InterviewRuntime:
    """Create only the registered adapter selected by the resolved interview."""

    if (
        resolved is not None
        and resolved.request.type is InterviewType.RESUME_MASTERY
    ):
        from .resume import ResumeMasteryRuntime

        return ResumeMasteryRuntime(resolved=resolved, metadata=metadata)

    from .mock import MockInterviewRuntime

    return MockInterviewRuntime(resolved=resolved, profile=profile)


def make_runtime_report(
    ctx: Any,
    runtime: InterviewRuntime | None,
) -> dict[str, object]:
    """Return Resume metadata-only progress or the existing session report."""

    if runtime is not None:
        runtime_report = runtime.report()
        if runtime_report is not None:
            return runtime_report
    try:
        report = ctx.make_session_report()
        value = report.to_dict()
        value.setdefault("started_at", report.started_at)
        value.setdefault("duration", report.duration)
        return value
    except Exception as error:
        logger.warning("Failed to create session report: %s", error)
        return {}


def prepare_runtime_prompt(
    *,
    metadata: Mapping[str, object],
    profile: Any,
    runtime: InterviewRuntime,
    room_name: str,
    job_id: str,
    plan_line: Callable[[Mapping[str, Any]], str],
) -> tuple[str | None, Any | None, dict[str, str] | None]:
    """Render the selected prompt while keeping Resume content tracing disabled."""

    from langfuse import get_client as get_langfuse_client
    from livekit.agents.telemetry import set_tracer_provider
    from opentelemetry.trace import NoOpTracerProvider

    from domains.interview.questions.store import (
        QuestionStore,
        normalize_supplied_questions,
    )
    from infrastructure.logging.langfuse import setup_langfuse
    from infrastructure.prompt import extract_prompt_version, load_prompt, render_prompt

    _configure_sdk_content_logging(enabled=runtime.content_tracing_enabled)
    prompt_version = extract_prompt_version(runtime.prompt_url)
    if runtime.content_tracing_enabled:
        try:
            setup_langfuse(
                metadata={
                    "langfuse.session.id": room_name,
                    "langfuse.user.id": "anonymous",
                    "agent_id": profile.id,
                    "agent_name": profile.agent_type,
                    "job_id": job_id,
                    "prompt_version": prompt_version,
                    "langfuse.prompt.name": "diagnostic-agent",
                    "langfuse.prompt.label": prompt_version,
                }
            )
        except Exception as error:
            logger.warning("Langfuse setup failed: %s", error)
    else:
        set_tracer_provider(NoOpTracerProvider())
        assert runtime.resolved is not None
        logger.info(
            "resume_content_tracing status=disabled mode=%s version=%s round=%s",
            runtime.resolved.request.type.value,
            runtime.resolved.request.version,
            runtime.resolved.request.round,
        )

    try:
        prompt_template = load_prompt(runtime.prompt_url)
    except Exception as error:
        logger.error(
            "Failed to load prompt for agent_id=%s error_type=%s",
            profile.id,
            type(error).__name__,
        )
        return None, None, None

    prompt_context = runtime.build_prompt_context(metadata)
    question_store = QuestionStore()
    supplied = (
        normalize_supplied_questions(metadata.get("questions"))
        if runtime.accepts_frontend_questions
        else []
    )
    if supplied:
        question_store.load(supplied)
        prompt_context["interview_plan"] = "\n".join(
            plan_line(question) for question in question_store.public_plan()
        )
    elif runtime.accepts_frontend_questions and isinstance(
        metadata.get("questions"), list
    ):
        prompt_context["interview_plan"] = ""

    instructions = render_prompt(prompt_template, context=prompt_context)
    if runtime.content_tracing_enabled:
        try:
            langfuse = get_langfuse_client()
            langfuse.get_prompt(
                "diagnostic-agent",
                label=prompt_version,
                fallback=instructions,
            )
            langfuse.trace(
                id=room_name,
                metadata={
                    "prompt_version": prompt_version,
                    "prompt_char_count": len(instructions),
                },
            )
        except Exception as error:
            logger.warning("Langfuse trace enrichment failed: %s", error)
    return instructions, question_store, prompt_context
