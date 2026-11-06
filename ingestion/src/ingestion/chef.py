"""Chef: raw file -> markdown (per file type) -> PII redaction -> redacted .md on disk -> Document.

Redaction runs per markdown block (a transcript turn, a paragraph, a table) and fails closed:
if any block cannot be checked, nothing is written and the file fails.
"""
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any, Callable, Optional

import yaml
from chonkie.chef.base import BaseChef
from chonkie.pipeline import chef
from chonkie.types import Document

from .converters import text_to_md, to_markdown
from .vendor import pii_redact

# The redactor replies within 600 tokens; a 684-word reference list overflowed it. Benchmarked on turns.
MAX_UNIT_WORDS = 120


def redaction_units(block: str, max_words: int = MAX_UNIT_WORDS) -> list[str]:
    """Split a long block at line, then sentence, boundaries; the pieces concatenate back exactly."""
    if len(block.split()) <= max_words:
        return [block]
    pieces = []
    for line in re.split(r"(?<=\n)", block):
        pieces += re.split(r"(?<=[.!?])(?=\s)", line) if len(line.split()) > max_words else [line]
    units, cur = [], ""
    for p in pieces:
        if cur.strip() and len((cur + p).split()) > max_words:
            units.append(cur)
            cur = ""
        cur += p
    return units + [cur] if cur else units


@chef("redacted_markdown")
class RedactedMarkdownChef(BaseChef):
    def __init__(self, out_dir: str, doc_meta: dict[str, Any], redact_fn: Optional[Callable] = None,
                 convert_fn: Optional[Callable] = None) -> None:
        if not doc_meta.get("docId"):
            raise ValueError("doc_meta needs a docId")
        self.out_dir = Path(out_dir)
        self.doc_meta = dict(doc_meta)
        # redact_fn(blocks) -> (redacted_blocks, spans, mapping); the mapping holds real values and is dropped.
        self.redact_fn = redact_fn or pii_redact.redact_transcript
        self.convert_fn = convert_fn or to_markdown

    def process(self, path: str | os.PathLike) -> Document:
        path = Path(path)
        title, md = self.convert_fn(path)
        return self._finish(title, md, path.suffix.lower().lstrip("."))

    def parse(self, text: str) -> Document:
        title, md = text_to_md(text)
        return self._finish(title, md, "text")

    def _finish(self, title: str, md: str, source_type: str) -> Document:
        blocks = [b.strip() for b in md.split("\n\n") if b.strip()]
        if not blocks:
            raise ValueError("file has no content after conversion")
        units = [redaction_units(b) for b in blocks]
        flat = [title or ""] + [u for us in units for u in us]
        redacted, _spans, _mapping = self.redact_fn(flat)  # raises RedactionError: fail closed
        title, pos, out = redacted[0].strip(), 1, []
        for us in units:
            out.append("".join(redacted[pos:pos + len(us)]))
            pos += len(us)
        body = "\n\n".join(out)
        meta = {**self.doc_meta, "title": title, "sourceType": source_type}
        self.out_dir.mkdir(parents=True, exist_ok=True)
        out = self.out_dir / f"{meta['docId']}.md"
        tmp = out.with_suffix(".md.tmp")
        tmp.write_text("---\n" + yaml.safe_dump(meta, sort_keys=False, allow_unicode=True) + "---\n\n" + body + "\n",
                       encoding="utf-8")
        tmp.replace(out)  # atomic: a crash never leaves a half-written redacted file
        return Document(id=meta["docId"], content=body, metadata=meta)
