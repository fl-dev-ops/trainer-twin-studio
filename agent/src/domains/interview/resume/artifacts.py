"""Strict parsing for private, server-authored Resume artifact references."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from domains.interview.documents.validation import (
    require_exact_keys,
    require_mapping,
    require_sha256,
    require_string,
)


class ResumeArtifactReferenceError(ValueError):
    pass


@dataclass(frozen=True)
class ResumeArtifactReference:
    pdf_key: str
    document_key: str
    pdf_sha256: str

    @property
    def session_prefix(self) -> str:
        return self.pdf_key.removesuffix("/resume/original.pdf")


def _validate_s3_key(key: str, field: str, suffix: str) -> str:
    if "\\" in key or any(ord(character) < 32 for character in key):
        raise ResumeArtifactReferenceError(f"{field} contains invalid characters")
    segments = key.split("/")
    if any(segment in {"", ".", ".."} for segment in segments):
        raise ResumeArtifactReferenceError(f"{field} contains an invalid path segment")
    if not key.endswith(suffix):
        raise ResumeArtifactReferenceError(f"{field} must end with {suffix!r}")
    prefix = key.removesuffix(suffix)
    if not prefix:
        raise ResumeArtifactReferenceError(f"{field} must include a session prefix")
    return prefix


def parse_resume_artifact_reference(
    private_job_metadata: Mapping[str, Any],
) -> ResumeArtifactReference:
    """Read only the strict `resume` object from private job metadata."""

    try:
        raw = require_mapping(private_job_metadata.get("resume"), "metadata.resume")
        keys = {"pdf_key", "document_key", "pdf_sha256"}
        require_exact_keys(raw, required=keys, field="metadata.resume")
        pdf_key = require_string(raw["pdf_key"], "metadata.resume.pdf_key")
        document_key = require_string(
            raw["document_key"], "metadata.resume.document_key"
        )
        pdf_sha256 = require_sha256(
            raw["pdf_sha256"], "metadata.resume.pdf_sha256"
        )
    except ValueError as error:
        raise ResumeArtifactReferenceError(str(error)) from error

    pdf_prefix = _validate_s3_key(
        pdf_key,
        "metadata.resume.pdf_key",
        "/resume/original.pdf",
    )
    document_prefix = _validate_s3_key(
        document_key,
        "metadata.resume.document_key",
        "/resume/document.v1.json",
    )
    if pdf_prefix != document_prefix:
        raise ResumeArtifactReferenceError(
            "metadata.resume keys must share the same session prefix"
        )
    return ResumeArtifactReference(
        pdf_key=pdf_key,
        document_key=document_key,
        pdf_sha256=pdf_sha256,
    )
