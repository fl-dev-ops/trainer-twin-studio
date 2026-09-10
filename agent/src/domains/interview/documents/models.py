"""Neutral, library-independent source-document primitives."""

from __future__ import annotations

from dataclasses import dataclass


class SourceDocumentError(ValueError):
    """Raised when a source document violates its versioned contract."""


@dataclass(frozen=True)
class PdfRectV1:
    """A normalized PDF rectangle using a top-left coordinate origin."""

    page: int
    x1: float
    y1: float
    x2: float
    y2: float


@dataclass(frozen=True)
class PdfAnchorV1:
    """A stable piece of verbatim PDF text and its page coordinates."""

    id: str
    page: int
    text: str
    text_sha256: str
    rectangles: tuple[PdfRectV1, ...]


@dataclass(frozen=True)
class SourceDocumentV1:
    """Validated PDF source facts shared by composed document types."""

    pdf_sha256: str
    page_count: int
    extracted_character_count: int
    anchor_count: int
    anchors: tuple[PdfAnchorV1, ...]


@dataclass(frozen=True)
class SourceDocumentLimits:
    """Configured hard limits for neutral source-document validation."""

    max_pdf_pages: int
    max_extracted_characters: int
    max_anchors: int
    max_rectangles_per_anchor: int
    max_document_json_bytes: int
