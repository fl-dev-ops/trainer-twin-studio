"""Strict parsing helpers for neutral source-document contracts."""

from __future__ import annotations

import hashlib
import json
import math
import re
from collections.abc import Mapping, Sequence
from typing import Any

from .models import (
    PdfAnchorV1,
    PdfRectV1,
    SourceDocumentError,
    SourceDocumentLimits,
    SourceDocumentV1,
)

_SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
_SOURCE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")


def require_mapping(value: Any, field: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping) or not all(
        isinstance(key, str) for key in value
    ):
        raise SourceDocumentError(f"{field} must be an object with string keys")
    return value


def require_exact_keys(
    value: Mapping[str, Any],
    *,
    required: set[str],
    optional: set[str] | None = None,
    field: str,
) -> None:
    allowed = required | (optional or set())
    unknown = sorted(set(value) - allowed)
    missing = sorted(required - set(value))
    if unknown:
        raise SourceDocumentError(f"{field} contains unknown keys: {unknown}")
    if missing:
        raise SourceDocumentError(f"{field} is missing required keys: {missing}")


def require_string(value: Any, field: str, *, verbatim: bool = False) -> str:
    if not isinstance(value, str) or not value.strip():
        raise SourceDocumentError(f"{field} must be a non-empty string")
    if not verbatim and value != value.strip():
        raise SourceDocumentError(f"{field} must not have surrounding whitespace")
    return value


def require_non_negative_int(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise SourceDocumentError(f"{field} must be a non-negative integer")
    return value


def require_positive_int(value: Any, field: str) -> int:
    parsed = require_non_negative_int(value, field)
    if parsed == 0:
        raise SourceDocumentError(f"{field} must be greater than zero")
    return parsed


def require_list(value: Any, field: str) -> Sequence[Any]:
    if not isinstance(value, list):
        raise SourceDocumentError(f"{field} must be an array")
    return value


def require_sha256(value: Any, field: str) -> str:
    parsed = require_string(value, field)
    if not _SHA256_RE.fullmatch(parsed):
        raise SourceDocumentError(f"{field} must be a lowercase SHA-256 digest")
    return parsed


def normalize_source_text(value: str) -> str:
    """Normalize only whitespace when comparing verbatim source fragments."""

    return " ".join(value.split())


def serialized_json_size(value: Mapping[str, Any]) -> int:
    try:
        encoded = json.dumps(
            value,
            ensure_ascii=False,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError) as error:
        raise SourceDocumentError("document must contain valid JSON values") from error
    return len(encoded)


def parse_pdf_rect(value: Any, field: str, *, anchor_page: int) -> PdfRectV1:
    raw = require_mapping(value, field)
    keys = {"page", "x1", "y1", "x2", "y2"}
    require_exact_keys(raw, required=keys, field=field)
    page = require_positive_int(raw["page"], f"{field}.page")
    if page != anchor_page:
        raise SourceDocumentError(
            f"{field}.page must match its containing anchor page"
        )

    coordinates: dict[str, float] = {}
    for key in ("x1", "y1", "x2", "y2"):
        item = raw[key]
        if isinstance(item, bool) or not isinstance(item, (int, float)):
            raise SourceDocumentError(f"{field}.{key} must be a finite number")
        parsed = float(item)
        if not math.isfinite(parsed):
            raise SourceDocumentError(f"{field}.{key} must be a finite number")
        coordinates[key] = parsed

    x1 = coordinates["x1"]
    y1 = coordinates["y1"]
    x2 = coordinates["x2"]
    y2 = coordinates["y2"]
    if not 0 <= x1 < x2 <= 1 or not 0 <= y1 < y2 <= 1:
        raise SourceDocumentError(
            f"{field} must satisfy 0 <= x1 < x2 <= 1 and 0 <= y1 < y2 <= 1"
        )
    return PdfRectV1(page=page, x1=x1, y1=y1, x2=x2, y2=y2)


def parse_pdf_anchor(
    value: Any,
    *,
    field: str,
    page_count: int,
    max_rectangles: int,
) -> PdfAnchorV1:
    raw = require_mapping(value, field)
    keys = {"id", "page", "text", "text_sha256", "rectangles"}
    require_exact_keys(raw, required=keys, field=field)

    anchor_id = require_string(raw["id"], f"{field}.id")
    if not _SOURCE_ID_RE.fullmatch(anchor_id):
        raise SourceDocumentError(f"{field}.id has an invalid format")
    page = require_positive_int(raw["page"], f"{field}.page")
    if page > page_count:
        raise SourceDocumentError(f"{field}.page exceeds document page_count")
    text = require_string(raw["text"], f"{field}.text", verbatim=True)
    text_sha256 = require_sha256(raw["text_sha256"], f"{field}.text_sha256")
    expected_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
    if text_sha256 != expected_hash:
        raise SourceDocumentError(f"{field}.text_sha256 does not match text")

    rectangles_value = require_list(raw["rectangles"], f"{field}.rectangles")
    if not rectangles_value or len(rectangles_value) > max_rectangles:
        raise SourceDocumentError(
            f"{field}.rectangles must contain 1 through {max_rectangles} items"
        )
    rectangles = tuple(
        parse_pdf_rect(
            item,
            f"{field}.rectangles[{index}]",
            anchor_page=page,
        )
        for index, item in enumerate(rectangles_value)
    )
    return PdfAnchorV1(
        id=anchor_id,
        page=page,
        text=text,
        text_sha256=text_sha256,
        rectangles=rectangles,
    )


def parse_source_document(
    value: Mapping[str, Any],
    *,
    limits: SourceDocumentLimits,
) -> SourceDocumentV1:
    page_count = require_positive_int(value["page_count"], "document.page_count")
    if page_count > limits.max_pdf_pages:
        raise SourceDocumentError("document.page_count exceeds configured limit")

    extracted_count = require_non_negative_int(
        value["extracted_character_count"],
        "document.extracted_character_count",
    )
    if extracted_count == 0:
        raise SourceDocumentError("document contains no extracted text")
    if extracted_count > limits.max_extracted_characters:
        raise SourceDocumentError(
            "document.extracted_character_count exceeds configured limit"
        )

    anchor_count = require_non_negative_int(
        value["anchor_count"], "document.anchor_count"
    )
    anchors_value = require_list(value["anchors"], "document.anchors")
    if anchor_count != len(anchors_value):
        raise SourceDocumentError("document.anchor_count does not match anchors")
    if anchor_count == 0 or anchor_count > limits.max_anchors:
        raise SourceDocumentError("document.anchor_count is outside configured limits")

    anchors = tuple(
        parse_pdf_anchor(
            item,
            field=f"document.anchors[{index}]",
            page_count=page_count,
            max_rectangles=limits.max_rectangles_per_anchor,
        )
        for index, item in enumerate(anchors_value)
    )
    ids = [anchor.id for anchor in anchors]
    if len(ids) != len(set(ids)):
        raise SourceDocumentError("document.anchors contains duplicate ids")
    if sum(len(anchor.text) for anchor in anchors) != extracted_count:
        raise SourceDocumentError(
            "document.extracted_character_count does not match anchor text"
        )
    return SourceDocumentV1(
        pdf_sha256=require_sha256(value["pdf_sha256"], "document.pdf_sha256"),
        page_count=page_count,
        extracted_character_count=extracted_count,
        anchor_count=anchor_count,
        anchors=anchors,
    )
