"""Session configuration and types."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class InteractionMode(str, Enum):
    """Interaction mode for the session."""

    AUTO = "auto"
    PTT = "ptt"


@dataclass(frozen=True)
class SessionConfig:
    """Configuration for an agent session."""

    voice: str | None = None
    speaking_speed: float | None = None
    dict_id: str | None = None
