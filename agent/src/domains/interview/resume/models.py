"""Resume-specific composition and strict document validation."""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from enum import Enum
from typing import Any

from domains.interview.documents import (
    PdfAnchorV1,
    SourceDocumentError,
    SourceDocumentLimits,
    SourceDocumentV1,
    normalize_source_text,
    parse_source_document,
)
from domains.interview.documents.validation import (
    require_exact_keys,
    require_list,
    require_mapping,
    require_non_negative_int,
    require_positive_int,
    require_string,
    serialized_json_size,
)

RESUME_DOCUMENT_SCHEMA = "resume_document.v1"
_CLAIM_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_MAX_SECTION_CHARACTERS = 120
_MAX_METRIC_CHARACTERS = 500

_CONTACT_SECTION_RE = re.compile(
    r"^(contact|contact information|personal details|personal information)$",
    re.IGNORECASE,
)
_EMAIL_RE = re.compile(r"(?<![\w.+-])[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}(?![\w.-])")
_PHONE_RE = re.compile(r"(?<!\w)(?:\+?\d[\d\s().-]{7,}\d)(?!\w)")
_URL_RE = re.compile(r"(?i)(?:https?://|www\.|linkedin\.com/|github\.com/)\S+")
_ADDRESS_RE = re.compile(
    r"(?i)\b\d{1,6}\s+[\w.'-]+(?:\s+[\w.'-]+){0,5}\s+"
    r"(?:street|st|road|rd|avenue|ave|lane|ln|drive|dr|boulevard|blvd)\b"
)
_CONTROL_PATTERNS = (
    re.compile(r"(?i)\bignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions\b"),
    re.compile(r"(?i)\b(?:system|developer|assistant)\s+prompt\s*:"),
    re.compile(r"(?i)^\s*(?:system|developer|assistant)\s*:"),
    re.compile(r"(?i)\bfollow\s+(?:these|the following)\s+instructions\b"),
    re.compile(r"(?i)\byou are (?:chatgpt|an ai assistant|the interviewer)\b"),
)


class ResumeClaimKind(str, Enum):
    PROJECT = "project"
    EXPERIENCE = "experience"
    IMPACT = "impact"
    ARCHITECTURE = "architecture"
    TECHNOLOGY = "technology"
    EDUCATION = "education"
    OTHER = "other"


@dataclass(frozen=True)
class ResumeClaimV1:
    id: str
    section: str
    kind: ResumeClaimKind
    text: str
    anchor_ids: tuple[str, ...]
    metric: str | None = None


@dataclass(frozen=True)
class ResumeDocumentLimits:
    max_pdf_bytes: int
    max_pdf_pages: int
    max_extracted_characters: int
    max_anchors: int
    max_rectangles_per_anchor: int
    max_claims: int
    max_anchors_per_claim: int
    max_document_json_bytes: int

    @classmethod
    def from_config_limits(cls, limits: Mapping[str, Any]) -> ResumeDocumentLimits:
        names = (
            "max_pdf_bytes",
            "max_pdf_pages",
            "max_extracted_characters",
            "max_anchors",
            "max_rectangles_per_anchor",
            "max_claims",
            "max_anchors_per_claim",
            "max_document_json_bytes",
        )
        values = {
            name: require_positive_int(limits.get(name), f"limits.{name}")
            for name in names
        }
        return cls(**values)

    def source_limits(self) -> SourceDocumentLimits:
        return SourceDocumentLimits(
            max_pdf_pages=self.max_pdf_pages,
            max_extracted_characters=self.max_extracted_characters,
            max_anchors=self.max_anchors,
            max_rectangles_per_anchor=self.max_rectangles_per_anchor,
            max_document_json_bytes=self.max_document_json_bytes,
        )

    def validate_pdf_size(self, byte_count: int) -> None:
        if isinstance(byte_count, bool) or not isinstance(byte_count, int):
            raise SourceDocumentError("PDF byte count must be an integer")
        if byte_count <= 0 or byte_count > self.max_pdf_bytes:
            raise SourceDocumentError("PDF byte count is outside configured limits")


@dataclass(frozen=True)
class ResumeDocumentV1:
    schema_version: str
    source: SourceDocumentV1
    claim_count: int
    claims: tuple[ResumeClaimV1, ...]

    def claim(self, claim_id: str) -> ResumeClaimV1 | None:
        return next((claim for claim in self.claims if claim.id == claim_id), None)

    def anchor(self, anchor_id: str) -> PdfAnchorV1 | None:
        return next(
            (anchor for anchor in self.source.anchors if anchor.id == anchor_id),
            None,
        )


def is_contact_like_text(text: str) -> bool:
    return any(
        pattern.search(text)
        for pattern in (_EMAIL_RE, _PHONE_RE, _URL_RE, _ADDRESS_RE)
    )


def is_control_like_text(text: str) -> bool:
    return any(pattern.search(text) for pattern in _CONTROL_PATTERNS)


def is_contact_section(section: str) -> bool:
    return bool(_CONTACT_SECTION_RE.fullmatch(normalize_source_text(section)))


def _parse_claim(
    value: Any,
    *,
    index: int,
    anchors_by_id: Mapping[str, PdfAnchorV1],
    max_anchors: int,
    anchor_positions: Mapping[str, int],
    max_text_characters: int,
) -> ResumeClaimV1:
    field = f"document.claims[{index}]"
    raw = require_mapping(value, field)
    required = {"id", "section", "kind", "text", "anchor_ids"}
    require_exact_keys(raw, required=required, optional={"metric"}, field=field)

    claim_id = require_string(raw["id"], f"{field}.id")
    if not _CLAIM_ID_RE.fullmatch(claim_id):
        raise SourceDocumentError(f"{field}.id has an invalid format")
    section = require_string(raw["section"], f"{field}.section", verbatim=True)
    if len(section) > _MAX_SECTION_CHARACTERS:
        raise SourceDocumentError(
            f"{field}.section must be at most {_MAX_SECTION_CHARACTERS} characters"
        )
    text = require_string(raw["text"], f"{field}.text", verbatim=True)
    if len(text) > max_text_characters:
        raise SourceDocumentError(
            f"{field}.text must be at most {max_text_characters} characters"
        )
    kind_value = require_string(raw["kind"], f"{field}.kind")
    try:
        kind = ResumeClaimKind(kind_value)
    except ValueError as error:
        allowed = [item.value for item in ResumeClaimKind]
        raise SourceDocumentError(
            f"{field}.kind must be one of {allowed}; got {kind_value!r}"
        ) from error

    anchor_ids_value = require_list(raw["anchor_ids"], f"{field}.anchor_ids")
    if not anchor_ids_value or len(anchor_ids_value) > max_anchors:
        raise SourceDocumentError(
            f"{field}.anchor_ids must contain 1 through {max_anchors} items"
        )
    anchor_ids = tuple(
        require_string(item, f"{field}.anchor_ids[{anchor_index}]")
        for anchor_index, item in enumerate(anchor_ids_value)
    )
    if len(anchor_ids) != len(set(anchor_ids)):
        raise SourceDocumentError(f"{field}.anchor_ids contains duplicates")
    positions = [anchor_positions[anchor_id] for anchor_id in anchor_ids if anchor_id in anchor_positions]
    if len(positions) == len(anchor_ids) and positions != sorted(positions):
        raise SourceDocumentError(f"{field}.anchor_ids must preserve source order")
    try:
        anchors = tuple(anchors_by_id[anchor_id] for anchor_id in anchor_ids)
    except KeyError as error:
        raise SourceDocumentError(
            f"{field}.anchor_ids references an unknown anchor"
        ) from error
    if len({anchor.page for anchor in anchors}) != 1:
        raise SourceDocumentError(f"{field}.anchor_ids must reference one page")

    grounded_text = normalize_source_text(" ".join(anchor.text for anchor in anchors))
    if normalize_source_text(text) != grounded_text:
        raise SourceDocumentError(f"{field}.text is not exact normalized source text")

    metric = None
    if "metric" in raw:
        metric = require_string(raw["metric"], f"{field}.metric", verbatim=True)
        if len(metric) > _MAX_METRIC_CHARACTERS:
            raise SourceDocumentError(
                f"{field}.metric must be at most {_MAX_METRIC_CHARACTERS} characters"
            )
        if metric not in text:
            raise SourceDocumentError(f"{field}.metric must be an exact text substring")

    if is_contact_section(section) or is_contact_like_text(text):
        raise SourceDocumentError(f"{field} contains contact-like content")
    if is_control_like_text(text):
        raise SourceDocumentError(f"{field} contains control-like content")
    return ResumeClaimV1(
        id=claim_id,
        section=section,
        kind=kind,
        text=text,
        anchor_ids=anchor_ids,
        metric=metric,
    )


def parse_resume_document(
    value: Any,
    *,
    limits: ResumeDocumentLimits,
    serialized_size_bytes: int | None = None,
) -> ResumeDocumentV1:
    raw = require_mapping(value, "document")
    keys = {
        "schema_version",
        "pdf_sha256",
        "page_count",
        "extracted_character_count",
        "anchor_count",
        "claim_count",
        "anchors",
        "claims",
    }
    require_exact_keys(raw, required=keys, field="document")
    if serialized_size_bytes is not None and (
        isinstance(serialized_size_bytes, bool)
        or not isinstance(serialized_size_bytes, int)
    ):
        raise SourceDocumentError("document JSON byte count must be an integer")
    actual_size = (
        serialized_json_size(raw)
        if serialized_size_bytes is None
        else serialized_size_bytes
    )
    if actual_size <= 0 or actual_size > limits.max_document_json_bytes:
        raise SourceDocumentError("document JSON byte count exceeds configured limit")

    schema_version = require_string(
        raw["schema_version"], "document.schema_version"
    )
    if schema_version != RESUME_DOCUMENT_SCHEMA:
        raise SourceDocumentError(
            "document.schema_version must be "
            f"{RESUME_DOCUMENT_SCHEMA!r}"
        )
    source = parse_source_document(raw, limits=limits.source_limits())
    for index, anchor in enumerate(source.anchors):
        if is_contact_like_text(anchor.text):
            raise SourceDocumentError(
                f"document.anchors[{index}] contains contact-like content"
            )
        if is_control_like_text(anchor.text):
            raise SourceDocumentError(
                f"document.anchors[{index}] contains control-like content"
            )

    claim_count = require_non_negative_int(raw["claim_count"], "document.claim_count")
    claims_value = require_list(raw["claims"], "document.claims")
    if claim_count != len(claims_value):
        raise SourceDocumentError("document.claim_count does not match claims")
    if claim_count > limits.max_claims:
        raise SourceDocumentError("document.claim_count exceeds configured limit")

    anchors_by_id = {anchor.id: anchor for anchor in source.anchors}
    anchor_positions = {
        anchor.id: index for index, anchor in enumerate(source.anchors)
    }
    claims = tuple(
        _parse_claim(
            item,
            index=index,
            anchors_by_id=anchors_by_id,
            max_anchors=limits.max_anchors_per_claim,
            anchor_positions=anchor_positions,
            max_text_characters=limits.max_extracted_characters,
        )
        for index, item in enumerate(claims_value)
    )
    ids = [claim.id for claim in claims]
    if len(ids) != len(set(ids)):
        raise SourceDocumentError("document.claims contains duplicate ids")
    return ResumeDocumentV1(
        schema_version=schema_version,
        source=source,
        claim_count=claim_count,
        claims=claims,
    )


def parse_resume_document_json(
    payload: bytes,
    *,
    limits: ResumeDocumentLimits,
) -> ResumeDocumentV1:
    if not isinstance(payload, bytes):
        raise SourceDocumentError("document JSON payload must be bytes")
    if not payload or len(payload) > limits.max_document_json_bytes:
        raise SourceDocumentError("document JSON byte count is outside configured limits")
    try:
        value = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SourceDocumentError("document JSON payload is invalid") from error
    return parse_resume_document(
        value,
        limits=limits,
        serialized_size_bytes=len(payload),
    )
