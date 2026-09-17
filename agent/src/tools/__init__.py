"""Voice transport has no workspace tools; chat owns the durable command loop."""

from __future__ import annotations

from typing import Any


def build_interview_tools(*, room: Any, participant_identity: str) -> list[Any]:
    return []


__all__ = ["build_interview_tools"]
