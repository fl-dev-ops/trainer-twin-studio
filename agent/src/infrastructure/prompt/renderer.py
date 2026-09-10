"""Prompt rendering and template context building."""

from __future__ import annotations

import json
import logging
from collections import UserDict
from collections.abc import Mapping
from typing import TypedDict

logger = logging.getLogger(__name__)

DEFAULT_PROMPT_USER_NAME = "the student"


class InterviewMetadata(TypedDict, total=False):
    user_name: str
    prompt_context: Mapping[str, object]


class PromptContext(TypedDict):
    adaptive_plan: str
    additional_context: str
    interview_plan: str
    resume_markdown: str
    user_name: str


class _SafePromptContext(UserDict[str, object]):
    def __missing__(self, key: str) -> str:
        logger.warning("Prompt placeholder '%s' missing from prompt_context", key)
        return ""


def _stringify_prompt_value(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return str(value)


def build_prompt_context(
    metadata: InterviewMetadata | Mapping[str, object] | None,
    *,
    user_name: str | None = None,
) -> dict[str, str]:
    prompt_context: PromptContext = {
        "adaptive_plan": "",
        "additional_context": "",
        "interview_plan": "",
        "resume_markdown": "",
        "user_name": (user_name or "").strip() or DEFAULT_PROMPT_USER_NAME,
    }

    if not metadata:
        return {key: str(value) for key, value in prompt_context.items()}

    metadata_user_name = metadata.get("user_name")
    if isinstance(metadata_user_name, str) and metadata_user_name.strip():
        prompt_context["user_name"] = metadata_user_name.strip()

    context: dict[str, str] = {key: str(value) for key, value in prompt_context.items()}

    metadata_prompt_context = metadata.get("prompt_context")
    if isinstance(metadata_prompt_context, Mapping):
        additional_context: dict[str, str] = {}
        for key, value in metadata_prompt_context.items():
            if isinstance(key, str) and key:
                string_value = _stringify_prompt_value(value)
                context[key] = string_value
                if (
                    key
                    not in {
                        "adaptive_plan",
                        "agent_name",
                        "interview_plan",
                        "resume_markdown",
                        "user_name",
                    }
                    and string_value
                ):
                    additional_context[key] = string_value

        if additional_context:
            context["additional_context"] = json.dumps(
                additional_context, ensure_ascii=True, sort_keys=True
            )

    return context


def render_prompt(
    template: str,
    *,
    context: Mapping[str, object] | None = None,
) -> str:
    safe_context = _SafePromptContext(
        {key: _stringify_prompt_value(value) for key, value in (context or {}).items()}
    )
    return template.format_map(safe_context).strip()
