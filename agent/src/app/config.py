"""Application configuration, data classes, and constants."""

from __future__ import annotations

import logging
import math
import os
import time
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

from domains.interview.evidence.tracker import InterviewEvidenceTracker
from domains.recording.config import RecordingConfig
from domains.screen import ScreenFeedbackRuntime
from domains.session import InteractionMode, SessionConfig
from infrastructure.config.profiles import AgentProfile

logger = logging.getLogger("intervoo_agent")

CALLER_LOOKUP_TIMEOUT_SECONDS = 300
SCREEN_FEEDBACK_CLOSE_TIMEOUT_SECONDS = 5
EVIDENCE_TRACKER_CLOSE_TIMEOUT_SECONDS = 5
RECORDING_START_AWAIT_TIMEOUT_SECONDS = 20
DEFAULT_AGENT_NAME = "intervoo-agent"
MAX_CONCURRENT_SESSIONS = 10

MOCK_INTERVIEW_AGENT_TYPE = "mock-interview-agent"

END_CALL_EXTRA_DESCRIPTION = (
    "Only end the call when the user clearly indicates the conversation is complete. "
    "A disabled screen share, unavailable editor frame, hint request, tool recovery "
    "result, or temporary tool failure is never a reason to end the call."
)
END_CALL_INSTRUCTIONS = "Thanks for practicing with me today. Goodbye."

APP_DIR = Path(__file__).resolve().parents[2]
load_dotenv(str(APP_DIR / ".env.local"))
load_dotenv(str(APP_DIR / ".env"))
DEFAULT_PROFILE_CONFIG_PATH = APP_DIR / "config" / "agents.json"
DEFAULT_INTERVIEW_CATALOG_PATH = APP_DIR / "config" / "interviews"


def resolve_profile_config_path() -> Path:
    override = os.getenv("AGENT_PROFILE_CONFIG")
    if override:
        return Path(override)
    return DEFAULT_PROFILE_CONFIG_PATH


def resolve_interview_catalog_path() -> Path:
    override = os.getenv("INTERVIEW_CATALOG_PATH")
    if override:
        return Path(override)
    return DEFAULT_INTERVIEW_CATALOG_PATH


REGISTERED_AGENT_NAME = os.getenv("AGENT_NAME", DEFAULT_AGENT_NAME)


@dataclass(frozen=True)
class SessionState:
    profile: AgentProfile
    room_name: str
    resolved_user_id: str | None
    participant_identity: str | None
    phone_number: str | None
    webhook_url: str | None
    recording_config: RecordingConfig | None = None
    recording_session_id: str | None = None
    egress_id: str | None = None
    audio_url: str | None = None
    audio_s3_key: str | None = None
    video_egress_id: str | None = None
    video_url: str | None = None
    video_s3_key: str | None = None
    evidence_tracker: InterviewEvidenceTracker | None = None
    interview_runtime: Any | None = None


_sessions: dict[str, SessionState] = {}
_session_usage_loggers: dict[str, Any] = {}
_screen_feedback_runtimes: dict[str, ScreenFeedbackRuntime] = {}


@dataclass(frozen=True)
class RecordingStartState:
    recording_session_id: str | None = None
    audio_url: str | None = None
    audio_s3_key: str | None = None
    egress_id: str | None = None
    video_url: str | None = None
    video_s3_key: str | None = None
    video_egress_id: str | None = None


class StartupTimer:
    def __init__(self, room_name: str) -> None:
        self.room_name = room_name
        self._last = time.perf_counter()

    def mark(self, phase: str) -> None:
        now = time.perf_counter()
        logger.info(
            "startup_phase phase=%s room=%s elapsed_ms=%.2f",
            phase,
            self.room_name,
            (now - self._last) * 1000,
        )
        self._last = now


def plan_line(question: Mapping[str, Any]) -> str:
    topics = question.get("topics")
    fields = [
        question["id"],
        question["questionType"],
        question["surface"],
        question["answerMode"],
        str(question.get("difficulty") or ""),
        ", ".join(topics) if isinstance(topics, list) else "",
    ]
    return " | ".join(field for field in fields if field)


def parse_room_metadata(metadata: str | None) -> dict[str, object]:
    if not metadata:
        return {}
    try:
        import json
        payload = json.loads(metadata)
    except Exception:
        logger.warning("Room metadata is not valid JSON")
        return {}
    if isinstance(payload, dict):
        return payload
    logger.warning("Room metadata is not an object")
    return {}


def parse_private_job_metadata(metadata: str | None) -> dict[str, object] | None:
    """Strictly parse present private dispatch metadata without legacy fallback."""

    if metadata is None or not metadata.strip():
        return None
    try:
        import json

        payload = json.loads(metadata)
    except Exception as error:
        raise ValueError("Private job metadata is not valid JSON") from error
    if not isinstance(payload, dict) or not all(
        isinstance(key, str) for key in payload
    ):
        raise ValueError("Private job metadata must be an object")
    return payload


def extract_session_config(metadata: Mapping[str, object] | None) -> SessionConfig:
    if not metadata:
        return SessionConfig()

    raw_config = metadata.get("config")
    if not isinstance(raw_config, Mapping):
        return SessionConfig()

    voice = raw_config.get("voice")
    normalized_voice = (
        voice.strip() if isinstance(voice, str) and voice.strip() else None
    )

    dict_id = raw_config.get("dict_id")
    normalized_dict_id = (
        dict_id.strip() if isinstance(dict_id, str) and dict_id.strip() else None
    )

    speaking_speed = raw_config.get("speaking_speed")
    normalized_speaking_speed: float | None = None
    if isinstance(speaking_speed, (int, float)) and math.isfinite(speaking_speed):
        normalized_speaking_speed = float(speaking_speed)
    elif isinstance(speaking_speed, str):
        try:
            parsed = float(speaking_speed)
        except ValueError:
            parsed = None
        if parsed is not None and math.isfinite(parsed):
            normalized_speaking_speed = parsed

    return SessionConfig(
        voice=normalized_voice,
        speaking_speed=normalized_speaking_speed,
        dict_id=normalized_dict_id,
    )


def resolve_interaction_mode(metadata: Mapping[str, object] | None) -> InteractionMode:
    if not metadata:
        return InteractionMode.AUTO
    interaction_mode = metadata.get("interaction_mode")
    if isinstance(interaction_mode, str):
        normalized = interaction_mode.strip().lower()
        if normalized == "ptt":
            return InteractionMode.PTT
        if normalized == "auto":
            return InteractionMode.AUTO
    return InteractionMode.AUTO


def build_recording_metadata(
    room_metadata: Mapping[str, object] | None,
    mode: InteractionMode,
    profile: AgentProfile,
    *,
    resume_mode: bool = False,
) -> dict[str, object]:
    if resume_mode:
        metadata: dict[str, object] = {}
        interview = room_metadata.get("interview") if room_metadata else None
        if isinstance(interview, Mapping):
            metadata["interview"] = {
                key: interview[key]
                for key in ("type", "version", "round")
                if isinstance(interview.get(key), str)
            }
    else:
        metadata = dict(room_metadata) if room_metadata else {}
    metadata["interaction_mode"] = mode.value
    metadata["agent_id"] = profile.id
    return metadata
