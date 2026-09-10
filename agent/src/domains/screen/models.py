"""Screen feedback domain models."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from enum import Enum

from livekit import rtc
from pydantic import BaseModel, Field, field_validator, model_validator


class ScreenFeedbackDecision(BaseModel):
    should_speak: bool
    confidence: float = Field(ge=0, le=1)
    feedback: str
    reason: str
    code_completion_percent: int | None = Field(default=None, ge=0, le=100)
    highlight_from_line: int | None = Field(default=None, ge=1)
    highlight_to_line: int | None = Field(default=None, ge=1)


class ResumeEndState(str, Enum):
    MORE_CONTENT = "more_content"
    APPARENT_END = "apparent_end"
    UNCERTAIN = "uncertain"


class ResumeScrollbarPosition(str, Enum):
    ABOVE_BOTTOM = "above_bottom"
    AT_BOTTOM = "at_bottom"
    NOT_VISIBLE = "not_visible"
    UNCERTAIN = "uncertain"


class ResumeDetails(BaseModel):
    education: list[str] = Field(default_factory=list)
    experience: list[str] = Field(default_factory=list)
    companies: list[str] = Field(default_factory=list)
    roles: list[str] = Field(default_factory=list)
    skills: list[str] = Field(default_factory=list)
    projects: list[str] = Field(default_factory=list)
    certifications: list[str] = Field(default_factory=list)

    @model_validator(mode="before")
    @classmethod
    def _coerce_null_lists(cls, data: object) -> object:
        if isinstance(data, dict):
            return {
                key: ([] if value is None else value) for key, value in data.items()
            }
        return data


class ResumeViewportObservation(BaseModel):
    visible_sections: list[str] = Field(default_factory=list)
    professional_facts: ResumeDetails = Field(default_factory=ResumeDetails)
    content_clipped_at_bottom: bool
    page_current: int | None = Field(default=None, ge=1)
    page_total: int | None = Field(default=None, ge=1)
    scrollbar_position: ResumeScrollbarPosition
    end_state: ResumeEndState
    end_reason: str = ""
    scroll_instruction: str = ""

    @field_validator("visible_sections", mode="before")
    @classmethod
    def _coerce_null_sections(cls, value: object) -> object:
        return [] if value is None else value

    @field_validator("professional_facts", mode="before")
    @classmethod
    def _coerce_null_facts(cls, value: object) -> object:
        return ResumeDetails() if value is None else value

    @field_validator("end_reason", "scroll_instruction", mode="before")
    @classmethod
    def _coerce_null_text(cls, value: object) -> object:
        return "" if value is None else value


class ScreenFeedbackTrigger(Enum):
    DEVIATION = "deviation"
    STALL = "stall"


@dataclass(frozen=True)
class ScreenSnapshot:
    frame: rtc.VideoFrame
    question: dict[str, str]
    revision: int
    inactive_seconds: float
