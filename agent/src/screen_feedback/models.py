"""Screen feedback data models."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from livekit import rtc
from pydantic import BaseModel, Field


class ScreenFeedbackDecision(BaseModel):
    should_speak: bool
    confidence: float = Field(ge=0, le=1)
    feedback: str
    reason: str
    code_completion_percent: int | None = Field(default=None, ge=0, le=100)
    highlight_from_line: int | None = Field(default=None, ge=1)
    highlight_to_line: int | None = Field(default=None, ge=1)


class ScreenFeedbackTrigger(Enum):
    DEVIATION = "deviation"
    STALL = "stall"


@dataclass(frozen=True)
class ScreenSnapshot:
    frame: rtc.VideoFrame
    question: dict[str, str]
    revision: int
    inactive_seconds: float
