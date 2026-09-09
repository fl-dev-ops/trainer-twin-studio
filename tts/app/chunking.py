"""Sentence- and clause-aware text chunking for long TTS requests."""

from __future__ import annotations

import re
from functools import lru_cache

import pysbd
import spacy

_PARAGRAPH_RE = re.compile(r"\n\s*\n")
_SEGMENTER = pysbd.Segmenter(language="en", clean=False)
_MIN_CHUNK_WORDS = 8
_MIN_CLAUSE_WORDS = 5


def _word_count(text: str) -> int:
    return len(text.split())


@lru_cache(maxsize=1)
def _nlp():
    # Most text only needs pysbd. Load the heavier parser lazily when a single
    # sentence is long enough to require clause detection.
    return spacy.load("en_core_web_sm", disable=["ner", "lemmatizer"])


def _clause_starts(sentence) -> list[int]:
    """Find natural starts of spoken clauses in a parsed sentence."""
    starts = {0}
    tokens = list(sentence)
    for i, token in enumerate(tokens):
        if i < _MIN_CLAUSE_WORDS:
            continue

        left_has_verb = any(t.pos_ in {"VERB", "AUX"} for t in tokens[:i])
        right_has_verb = any(t.pos_ in {"VERB", "AUX"} for t in tokens[i:])
        if not (left_has_verb and right_has_verb):
            continue

        # Keep cohesive transitions together: "and that is when..." and
        # "which is why...". Their conjunction provides the better boundary.
        previous = [t.lower_ for t in tokens[max(0, i - 3):i]]
        if token.lower_ in {"when", "why"} and previous[-2:] == ["that", "is"]:
            continue

        # Start the new chunk with the connector; never leave "and" or "but"
        # dangling at the end of the preceding audio.
        if token.dep_ in {"cc", "mark"}:
            starts.add(i)
        elif token.lower_ in {"however", "therefore", "meanwhile", "otherwise"}:
            starts.add(i)
        elif token.lower_ in {"which", "who", "where", "when"} and token.dep_ in {
            "nsubj", "nsubjpass", "advmod",
        }:
            starts.add(i)
        elif i and tokens[i - 1].text in {",", ";", ":", "—", "–"}:
            starts.add(i)

    return sorted(starts)


def _semantic_units(text: str) -> list[str]:
    units: list[str] = []
    for sentence in _nlp()(text).sents:
        tokens = list(sentence)
        starts = _clause_starts(sentence) + [len(tokens)]
        for start, end in zip(starts, starts[1:]):
            piece = "".join(token.text_with_ws for token in tokens[start:end]).strip()
            if piece:
                units.append(piece)
    return units


def _emergency_split(text: str, max_words: int) -> list[str]:
    # ponytail: malformed text with no parseable clause still needs a ceiling;
    # upgrade to language-specific parsers if non-English run-ons become common.
    words = text.split()
    return [" ".join(words[i:i + max_words]) for i in range(0, len(words), max_words)]


def _pack(units: list[str], target_words: int, max_words: int) -> list[str]:
    chunks: list[str] = []
    current = ""
    for unit in units:
        unit_words = _word_count(unit)
        if unit_words > max_words:
            if current:
                chunks.append(current)
                current = ""
            chunks.extend(_emergency_split(unit, max_words))
            continue

        candidate = f"{current} {unit}".strip()
        current_words = _word_count(current)
        candidate_words = _word_count(candidate)

        if not current:
            current = unit
        elif candidate_words > max_words:
            chunks.append(current)
            current = unit
        elif (
            current_words >= _MIN_CHUNK_WORDS
            and unit_words >= _MIN_CHUNK_WORDS
            and candidate_words > target_words
            and abs(current_words - target_words) <= abs(candidate_words - target_words)
        ):
            chunks.append(current)
            current = unit
        else:
            # Short endings such as "Let's dive in!" stay with the preceding
            # sentence rather than becoming tiny standalone requests.
            current = candidate

    if current:
        chunks.append(current)
    return chunks


def chunk_text(
    text: str,
    *,
    target_seconds: float,
    max_seconds: float,
    words_per_second: float,
) -> list[str]:
    """Chunk text at paragraphs, sentences, then clauses by speech duration."""
    if target_seconds <= 0 or max_seconds <= 0 or words_per_second <= 0:
        raise ValueError("chunk timing values must be positive")

    target_words = max(1, round(target_seconds * words_per_second))
    # A safety ceiling must not round upward past the configured duration.
    max_words = max(target_words, int(max_seconds * words_per_second))
    chunks: list[str] = []

    for paragraph in _PARAGRAPH_RE.split(text.strip()):
        units: list[str] = []
        for sentence in _SEGMENTER.segment(paragraph.strip()):
            sentence = sentence.strip()
            if not sentence:
                continue
            if _word_count(sentence) > max_words:
                units.extend(_semantic_units(sentence))
            else:
                units.append(sentence)
        chunks.extend(_pack(units, target_words, max_words))

    return chunks
