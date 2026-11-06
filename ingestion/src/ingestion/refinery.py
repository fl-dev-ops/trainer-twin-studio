"""Refinery: merge chunks under min_words into a neighbour. SlumberChunker caps size but never merges,
so a 344-word lesson came out as 155/86/68/35-word chunks. Merged text is re-sliced from the document,
so chunks stay exact slices of the redacted markdown."""
from __future__ import annotations

from chonkie.pipeline import refinery
from chonkie.refinery.base import BaseRefinery
from chonkie.types import Chunk, Document

MIN_WORDS = 150  # lab guide: avoid chunks under 150 words


@refinery("merge_small")
class MergeSmallRefinery(BaseRefinery):
    def __init__(self, min_words: int = MIN_WORDS) -> None:
        self.min_words = min_words

    def refine(self, chunks: list[Chunk]) -> list[Chunk]:
        raise NotImplementedError("needs the document text; use refine_document")

    def refine_document(self, document: Document) -> Document:
        out: list[Chunk] = []
        for c in document.chunks:
            prev = out[-1] if out else None
            if prev and prev.end_index == c.start_index and \
                    min(len(prev.text.split()), len(c.text.split())) < self.min_words:
                text = document.content[prev.start_index:c.end_index]
                out[-1] = Chunk(text=text, start_index=prev.start_index, end_index=c.end_index,
                                token_count=len(text.split()), metadata=prev.metadata)
            else:
                out.append(c)
        document.chunks = out
        return document
