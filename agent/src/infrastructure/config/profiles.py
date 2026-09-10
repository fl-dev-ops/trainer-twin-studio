"""Agent profile configuration and management."""

from __future__ import annotations

import json
import logging
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from domains.interview.runtime.models import InterviewRequest, parse_interview_request

logger = logging.getLogger(__name__)


class ProfileError(ValueError):
    pass


@dataclass(frozen=True)
class AgentProfile:
    id: str
    agent_type: str
    prompt_url: str
    initial_reply: str
    voice_speaker: str
    voice_dict_id: str | None
    end_call_enabled: bool
    editor_events_enabled: bool
    screen_inspection_enabled: bool
    screen_feedback_timer_enabled: bool
    default_interview: InterviewRequest | None


def _required_str(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ProfileError(f"{field} must be a non-empty string")
    return value.strip()


def _optional_str(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _parse_profile(agent_id: str, value: Any) -> AgentProfile:
    if not isinstance(value, Mapping):
        raise ProfileError(f"agents.{agent_id} must be an object")

    voice = value.get("voice")
    if not isinstance(voice, Mapping):
        raise ProfileError(f"agents.{agent_id}.voice must be an object")

    tools = value.get("tools") or {}
    if not isinstance(tools, Mapping):
        raise ProfileError(f"agents.{agent_id}.tools must be an object")

    raw_default_interview = value.get("default_interview")
    try:
        default_interview = (
            parse_interview_request(raw_default_interview)
            if raw_default_interview is not None
            else None
        )
    except ValueError as e:
        raise ProfileError(f"agents.{agent_id}.default_interview is invalid: {e}") from e

    return AgentProfile(
        id=agent_id,
        agent_type=_required_str(
            value.get("agent_type"), f"agents.{agent_id}.agent_type"
        ),
        prompt_url=_required_str(
            value.get("prompt_url"), f"agents.{agent_id}.prompt_url"
        ),
        initial_reply=_required_str(
            value.get("initial_reply"), f"agents.{agent_id}.initial_reply"
        ),
        voice_speaker=_required_str(
            voice.get("speaker"), f"agents.{agent_id}.voice.speaker"
        ),
        voice_dict_id=_optional_str(voice.get("dict_id")),
        end_call_enabled=bool(tools.get("end_call", False)),
        editor_events_enabled=bool(tools.get("editor_events", False)),
        screen_inspection_enabled=bool(tools.get("screen_inspection", False)),
        screen_feedback_timer_enabled=bool(
            tools.get("screen_feedback_timer", False)
        ),
        default_interview=default_interview,
    )


def parse_profile_catalog(payload: Mapping[str, Any]) -> dict[str, AgentProfile]:
    raw_agents = payload.get("agents")
    if not isinstance(raw_agents, Mapping) or not raw_agents:
        raise ProfileError("agents must be a non-empty object")

    catalog: dict[str, AgentProfile] = {}
    for raw_id, raw_profile in raw_agents.items():
        agent_id = _required_str(raw_id, "agent id")
        catalog[agent_id] = _parse_profile(agent_id, raw_profile)
    return catalog


def load_profile_catalog(path: str | Path) -> dict[str, AgentProfile]:
    config_path = Path(path)
    try:
        payload = json.loads(config_path.read_text(encoding="utf-8"))
    except FileNotFoundError as e:
        raise ProfileError(f"Profile config not found: {config_path}") from e
    except json.JSONDecodeError as e:
        raise ProfileError(f"Invalid profile JSON: {config_path}") from e
    if not isinstance(payload, Mapping):
        raise ProfileError("Profile config root must be an object")
    return parse_profile_catalog(payload)


def pick_profile(
    catalog: Mapping[str, AgentProfile],
    metadata: Mapping[str, object] | None,
) -> AgentProfile:
    if metadata is None:
        raise ProfileError("Room metadata is missing; cannot select agent profile")

    agent_id = _optional_str(metadata.get("agent_id"))
    if agent_id is None:
        raise ProfileError("Room metadata must include 'agent_id'")

    profile = catalog.get(agent_id)
    if profile is None:
        known = sorted(catalog.keys())
        raise ProfileError(f"Unknown agent_id {agent_id!r}; known: {known}")
    return profile
