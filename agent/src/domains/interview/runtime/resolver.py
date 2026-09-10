"""Resolve strict interview requests without wiring a runtime implementation."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Protocol

from .catalog import InterviewCatalog
from .models import (
    InterviewConfigError,
    InterviewRequest,
    ResolvedInterview,
    parse_interview_request,
)


class ProfileInterviewDefault(Protocol):
    default_interview: InterviewRequest | None


def resolve_interview(
    metadata: Mapping[str, object] | None,
    *,
    profile: ProfileInterviewDefault,
    catalog: InterviewCatalog,
) -> ResolvedInterview | None:
    if metadata is not None and "interview" in metadata:
        request = parse_interview_request(metadata["interview"])
    else:
        request = profile.default_interview

    if request is None:
        return None

    definition = catalog.require(request.type, request.version)
    if request.round is not None and request.round not in {
        item.id.value for item in definition.rounds
    }:
        raise InterviewConfigError(
            f"Round {request.round!r} is not defined for "
            f"{request.type.value}/{request.version}"
        )
    return ResolvedInterview(request=request, definition=definition)
