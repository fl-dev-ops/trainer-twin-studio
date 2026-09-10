"""Pure Resume round eligibility and angle validation policy."""

from __future__ import annotations

from collections.abc import Iterable
from enum import IntEnum

from domains.interview.runtime import ResumeRound

from .models import ResumeClaimKind, ResumeClaimV1

_WORK_KINDS = frozenset(
    {
        ResumeClaimKind.PROJECT,
        ResumeClaimKind.EXPERIENCE,
        ResumeClaimKind.IMPACT,
        ResumeClaimKind.ARCHITECTURE,
        ResumeClaimKind.TECHNOLOGY,
    }
)
_ROUND_1_KINDS = _WORK_KINDS - {ResumeClaimKind.IMPACT}


class ClaimEligibility(IntEnum):
    INELIGIBLE = 0
    FALLBACK = 1
    PREFERRED = 2


def classify_claim_eligibility(
    selected_round: ResumeRound,
    claim: ResumeClaimV1,
    *,
    is_contact: bool,
    is_control: bool,
    allow_round_2_fallback: bool = True,
) -> ClaimEligibility:
    """Classify one claim with the same policy used by preflight and tools."""

    if is_contact or is_control or claim.kind is ResumeClaimKind.OTHER:
        return ClaimEligibility.INELIGIBLE
    if selected_round is ResumeRound.ROUND_1:
        return (
            ClaimEligibility.PREFERRED
            if claim.kind in _ROUND_1_KINDS
            else ClaimEligibility.INELIGIBLE
        )
    if selected_round is ResumeRound.ROUND_2:
        if claim.kind is ResumeClaimKind.IMPACT or claim.metric is not None:
            return ClaimEligibility.PREFERRED
        if allow_round_2_fallback and claim.kind in _WORK_KINDS:
            return ClaimEligibility.FALLBACK
        return ClaimEligibility.INELIGIBLE
    if claim.kind in _WORK_KINDS or claim.kind is ResumeClaimKind.EDUCATION:
        return ClaimEligibility.PREFERRED
    return ClaimEligibility.INELIGIBLE


def is_claim_eligible(
    selected_round: ResumeRound,
    claim: ResumeClaimV1,
    *,
    is_contact: bool,
    is_control: bool,
    allow_round_2_fallback: bool = True,
) -> bool:
    return (
        classify_claim_eligibility(
            selected_round,
            claim,
            is_contact=is_contact,
            is_control=is_control,
            allow_round_2_fallback=allow_round_2_fallback,
        )
        is not ClaimEligibility.INELIGIBLE
    )


def require_round_angle(angle_id: str, allowed_angle_ids: Iterable[str]) -> str:
    """Validate one configured angle ID without owning the catalog values."""

    allowed = tuple(allowed_angle_ids)
    if angle_id not in allowed:
        raise ValueError(f"angle_id must be one of {list(allowed)}; got {angle_id!r}")
    return angle_id
