"""Regression tests driven by tests/chunking_cases.json."""

import json
import re
from pathlib import Path
from time import perf_counter_ns

import pytest

from app.chunking import chunk_text

CORPUS = json.loads((Path(__file__).with_name("chunking_cases.json")).read_text())
SETTINGS = CORPUS["settings"]
CASES = CORPUS["cases"]


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


@pytest.mark.parametrize("case", CASES, ids=[case["name"] for case in CASES])
def test_chunking_corpus(case):
    started = perf_counter_ns()
    chunks = chunk_text(case["text"], **SETTINGS)
    elapsed_ms = (perf_counter_ns() - started) / 1_000_000

    estimated_seconds = [round(len(chunk.split()) / SETTINGS["words_per_second"], 1) for chunk in chunks]
    print(
        f"\n[chunking] {case['name']}: {elapsed_ms:.2f} ms; "
        f"{len(chunks)} chunks; estimated speech seconds={estimated_seconds}"
    )

    assert chunks
    assert _normalize(" ".join(chunks)) == _normalize(case["text"]), "chunking lost or reordered text"
    assert all(seconds <= SETTINGS["max_seconds"] for seconds in estimated_seconds)
    if expected := case.get("expected_chunks"):
        assert chunks == expected


def test_chunking_emergency_fallback_and_empty_input():
    settings = SETTINGS
    chunks = chunk_text("word " * 100, **settings)
    max_words = int(settings["max_seconds"] * settings["words_per_second"])
    assert all(len(chunk.split()) <= max_words for chunk in chunks)
    assert " ".join(chunks).split() == ["word"] * 100
    assert chunk_text("", **settings) == []
