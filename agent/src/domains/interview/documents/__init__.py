"""Neutral source-document contracts."""

from .models import (
    PdfAnchorV1,
    PdfRectV1,
    SourceDocumentError,
    SourceDocumentLimits,
    SourceDocumentV1,
)
from .validation import normalize_source_text, parse_source_document

__all__ = [
    "PdfAnchorV1",
    "PdfRectV1",
    "SourceDocumentError",
    "SourceDocumentLimits",
    "SourceDocumentV1",
    "normalize_source_text",
    "parse_source_document",
]
