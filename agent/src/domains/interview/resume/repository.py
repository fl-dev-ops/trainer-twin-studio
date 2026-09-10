"""Validated Resume document repository over an injected JSON-object reader."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Protocol

from domains.interview.documents import SourceDocumentError
from domains.interview.runtime import ResumeRound

from .artifacts import ResumeArtifactReference
from .eligibility import ClaimEligibility, classify_claim_eligibility
from .models import (
    ResumeClaimV1,
    ResumeDocumentLimits,
    ResumeDocumentV1,
    parse_resume_document,
)


class JsonObjectReader(Protocol):
    def __call__(
        self,
        key: str,
        *,
        max_bytes: int,
    ) -> Mapping[str, Any]: ...


class ResumeRepositoryError(ValueError):
    """Raised when a loaded document cannot satisfy the Resume repository contract."""


class ResumeDocumentRepository:
    """Load once, verify the artifact hash, and expose only eligible claims."""

    def __init__(
        self,
        *,
        reference: ResumeArtifactReference,
        limits: ResumeDocumentLimits,
        read_json_object: JsonObjectReader,
    ) -> None:
        self._reference = reference
        self._limits = limits
        self._read_json_object = read_json_object
        self._document: ResumeDocumentV1 | None = None

    @property
    def document(self) -> ResumeDocumentV1:
        if self._document is None:
            raise ResumeRepositoryError("Resume document has not been loaded")
        return self._document

    def load(self) -> ResumeDocumentV1:
        """Read and validate the configured document without exposing raw JSON."""

        if self._document is not None:
            return self._document
        value = self._read_json_object(
            self._reference.document_key,
            max_bytes=self._limits.max_document_json_bytes,
        )
        try:
            document = parse_resume_document(value, limits=self._limits)
        except SourceDocumentError as error:
            raise ResumeRepositoryError("Resume document validation failed") from error
        if document.source.pdf_sha256 != self._reference.pdf_sha256:
            raise ResumeRepositoryError(
                "Resume document PDF hash does not match its artifact reference"
            )
        self._document = document
        return document

    def list_eligible_claims(
        self,
        selected_round: ResumeRound,
        *,
        allow_round_2_fallback: bool = True,
    ) -> tuple[ResumeClaimV1, ...]:
        """Return eligible claims with preferred claims before Round 2 fallbacks."""

        ranked: list[tuple[ClaimEligibility, int, ResumeClaimV1]] = []
        for index, claim in enumerate(self.document.claims):
            eligibility = classify_claim_eligibility(
                selected_round,
                claim,
                is_contact=False,
                is_control=False,
                allow_round_2_fallback=allow_round_2_fallback,
            )
            if eligibility is not ClaimEligibility.INELIGIBLE:
                ranked.append((eligibility, index, claim))
        ranked.sort(key=lambda item: (-int(item[0]), item[1]))
        return tuple(item[2] for item in ranked)

    def require_eligible_claim(
        self,
        selected_round: ResumeRound,
        claim_id: str,
        *,
        allow_round_2_fallback: bool = True,
    ) -> ResumeClaimV1:
        """Resolve one claim through the same eligibility policy as listing."""

        claim = self.document.claim(claim_id)
        if claim is None:
            raise ResumeRepositoryError("Resume claim was not found")
        eligibility = classify_claim_eligibility(
            selected_round,
            claim,
            is_contact=False,
            is_control=False,
            allow_round_2_fallback=allow_round_2_fallback,
        )
        if eligibility is ClaimEligibility.INELIGIBLE:
            raise ResumeRepositoryError("Resume claim is not eligible for this round")
        return claim
