"""Offline checks: no network. Redaction, conversion, the LLM and embeddings are faked."""
from __future__ import annotations

import json
import re

import numpy as np
import pytest
import yaml
from chonkie.embeddings.base import BaseEmbeddings
from chonkie.genie import BaseGenie

from ingestion import build_pipeline, doc_id_for
from chonkie.types import Chunk, Document

from ingestion.chef import RedactedMarkdownChef, redaction_units
from ingestion.refinery import MergeSmallRefinery
from ingestion.converters import UnsupportedFileType, to_markdown
from ingestion.vendor import pii_redact

PRICING = "The plan costs four thousand per month and the yearly price gives a discount. "
TRAINING = "Squats and deadlifts build the legs while rest days let the muscles recover. "
TRANSCRIPT = (
    "---\ntitle: 'Call with Rahul'\nspeakers:\n  speaker_1: null\n---\n\n"
    + "\n\n".join(f"speaker_{1 + i % 2}: {PRICING * 4}Call Rahul on 98765 43210." for i in range(5)) + "\n\n"
    + "\n\n".join(f"speaker_{1 + i % 2}: {TRAINING * 4}" for i in range(5)) + "\n"
)
META = {"orgId": "org1", "kbId": "kb1"}


def fake_redact(blocks):
    return [b.replace("Rahul", "[PERSON_1]").replace("98765 43210", "[PHONE_1]") for b in blocks], [], {}


class FakeGenie(BaseGenie):
    """Splits at the first passage about training."""
    calls = 0

    def generate(self, prompt):
        raise AssertionError("JSON mode expected")

    def generate_json(self, prompt, schema):
        FakeGenie.calls += 1
        ids = re.findall(r"^ID (\d+): (.*)$", prompt, re.M)
        hit = next((int(i) for i, t in ids if "Squats" in t and "costs" not in t), None)
        first = int(ids[0][0])
        return {"split_index": hit if hit and hit > first else int(ids[-1][0]) + 1}


class FakeEmbeddings(BaseEmbeddings):
    texts_embedded = 0

    def embed(self, text):
        return self.embed_batch([text])[0]

    def embed_batch(self, texts):
        FakeEmbeddings.texts_embedded += len(texts)
        return [np.full(8, (hash(t) % 100) / 100 + 0.01, dtype=np.float32) for t in texts]

    @property
    def dimension(self):
        return 8

    def get_tokenizer(self):
        return "word"

    def name(self):
        return "fake"


def test_chef_writes_redacted_markdown_and_keeps_turns(tmp_path):
    doc = RedactedMarkdownChef(str(tmp_path), {"docId": "d1", **META}, redact_fn=fake_redact).parse(TRANSCRIPT)
    out = (tmp_path / "d1.md").read_text()
    assert "Rahul" not in out and "98765" not in out and "[PHONE_1]" in out
    fm = yaml.safe_load(out.split("---\n")[1])
    assert fm["title"] == "Call with [PERSON_1]" and fm["docId"] == "d1"  # title is redacted too
    assert doc.content.count("speaker_") == 10 and doc.content in out


def test_chef_fails_closed_and_writes_nothing(tmp_path, monkeypatch):
    def boom(turn, **kw):
        raise pii_redact.RedactionError("provider down")
    monkeypatch.setattr(pii_redact, "detect", boom)
    with pytest.raises(pii_redact.RedactionError):
        RedactedMarkdownChef(str(tmp_path), {"docId": "d1"}).parse(TRANSCRIPT)
    assert not list(tmp_path.iterdir())


def test_long_blocks_split_for_redaction_and_rejoin_exactly():
    refs = "\n".join(f"- [{i}] A. Author{i} and B. Other. Some paper title about networks. Venue, 2007." for i in range(40))
    units = redaction_units(refs)
    assert "".join(units) == refs and len(units) > 1 and all(len(u.split()) <= 120 for u in units)
    long_line = "word " * 300 + "end."
    assert "".join(redaction_units(long_line)) == long_line


def test_bare_empty_json_reply_means_no_pii(monkeypatch):
    class R:
        status_code = 200
        def raise_for_status(self): pass
        def json(self): return {"choices": [{"message": {"content": "{}"}}]}
    monkeypatch.setenv("OPENROUTER_API_KEY", "x")
    monkeypatch.setattr(pii_redact.requests, "post", lambda *a, **k: R())
    assert pii_redact.detect("## 4.2 Dropout") == []


def test_small_chunks_merge_into_neighbours_as_exact_slices():
    content = "a " * 100 + "b " * 400 + "c " * 30
    cuts = [0, 200, 1000, len(content)]
    doc = Document(content=content, chunks=[Chunk(text=content[s:e], start_index=s, end_index=e, metadata={"docId": "d"})
                                            for s, e in zip(cuts, cuts[1:])])
    out = MergeSmallRefinery(min_words=150).refine_document(doc).chunks
    assert len(out) == 1 and out[0].text == content and out[0].metadata == {"docId": "d"}


def test_unknown_file_type_is_rejected(tmp_path):
    f = tmp_path / "deck.key"
    f.write_bytes(b"x")
    with pytest.raises(UnsupportedFileType):
        to_markdown(f)


def test_full_pipeline_outputs_markdown_and_chunks_embedded_once(tmp_path):
    src = tmp_path / "call.md"
    src.write_text(TRANSCRIPT)
    out = tmp_path / "out"
    doc_id = doc_id_for(src)
    FakeEmbeddings.texts_embedded = 0
    doc = build_pipeline(src, out, {"docId": doc_id, **META}, genie=FakeGenie(), embeddings=FakeEmbeddings(),
                         redact_fn=fake_redact).run()

    md = (out / f"{doc_id}.md").read_text()
    chunks = [json.loads(line) for line in (out / f"{doc_id}.chunks.jsonl").read_text().splitlines()]
    body = md.split("---\n", 2)[2].strip()
    assert len(chunks) == len(doc.chunks) == 2 and FakeGenie.calls >= 1
    assert "Squats" not in chunks[0]["text"] and chunks[1]["text"].lstrip().startswith("speaker_")
    assert all(len(c["embedding"]) == 8 for c in chunks) and FakeEmbeddings.texts_embedded == 2
    assert all(c["text"] in body for c in chunks)  # chunks are slices of the redacted markdown
    assert all(c["metadata"]["docId"] == doc_id and c["metadata"]["kbId"] == "kb1" for c in chunks)


def test_media_becomes_speaker_turns_and_the_transcript_is_deleted(tmp_path, monkeypatch):
    import httpx
    from ingestion import converters
    calls = []
    polls = iter([{"status": "processing"}, {"status": "completed", "utterances": [
        {"speaker": "B", "text": "Hi, how are you?"}, {"speaker": "A", "text": "Good."}, {"speaker": "B", "text": "Great."}]}])

    def route(req):
        calls.append(f"{req.method} {req.url.path}")
        if req.url.path == "/v2/upload":
            return httpx.Response(200, json={"upload_url": "https://cdn.assemblyai.test/a"})
        if req.method == "POST":
            assert json.loads(req.content)["speaker_labels"] is True
            return httpx.Response(200, json={"id": "t1"})
        return httpx.Response(200, json=next(polls) if req.method == "GET" else {})

    real_client = httpx.Client
    monkeypatch.setattr(converters.httpx, "Client", lambda **kw: real_client(transport=httpx.MockTransport(route), **kw))
    monkeypatch.setattr(converters.time, "sleep", lambda s: None)
    monkeypatch.setenv("ASSEMBLYAI_API_KEY", "k")
    f = tmp_path / "call.m4a"
    f.write_bytes(b"audio")
    assert to_markdown(f) == ("call", "speaker_1: Hi, how are you?\n\nspeaker_2: Good.\n\nspeaker_1: Great.")
    assert calls[-1] == "DELETE /v2/transcript/t1"


def test_front_matter_title_is_kept_and_stripped():
    from ingestion.converters import text_to_md
    assert text_to_md("---\ntitle: Call\n---\n\nbody") == ("Call", "body")
    assert text_to_md("---\n: not yaml [\n---\nbody", "f") == ("f", "---\n: not yaml [\n---\nbody")


def test_anydoc_converts_documents_locally(tmp_path):
    f = tmp_path / "plans.csv"
    f.write_text("plan,price\nmonthly,4000\nyearly,40000\n")
    title, md = to_markdown(f)
    assert title == "plans" and "| monthly | 4000 |" in md
