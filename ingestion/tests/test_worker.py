"""SQS worker, offline: fake SQS, fake download, results captured instead of POSTed."""
from __future__ import annotations

import json
import logging
import shutil

import httpx
import pytest

from ingestion import worker
from test_pipeline import TRANSCRIPT, FakeEmbeddings, FakeGenie, fake_redact

SIGNED = "?X-Amz-Signature=SECRET123"
MSG = {"docId": "doc1", "orgId": "org1", "kbId": "kb1", "filename": "call.md",
       "sourceUrl": "https://bucket.s3.amazonaws.com/raw/call.md" + SIGNED}


class FakeSQS:
    def __init__(self, bodies, receive_count=1):
        self.messages = [{"MessageId": f"m{i}", "ReceiptHandle": f"r{i}", "Body": b,
                          "Attributes": {"ApproximateReceiveCount": str(receive_count)}} for i, b in enumerate(bodies)]
        self.deleted = []

    def receive_message(self, **kw):
        return {"Messages": [self.messages.pop(0)]} if self.messages else {}

    def delete_message(self, QueueUrl, ReceiptHandle):
        self.deleted.append(ReceiptHandle)

    def change_message_visibility(self, **kw):
        pass


@pytest.fixture
def sent(tmp_path, monkeypatch):
    src = tmp_path / "raw.md"
    src.write_text(TRANSCRIPT)
    monkeypatch.setattr(worker, "download", lambda url, dest, **k: shutil.copy(src, dest))
    out = []
    kw = dict(send=out.append, genie=FakeGenie(), embeddings=FakeEmbeddings(), redact_fn=fake_redact)
    monkeypatch.setattr(worker, "handle", lambda body, attempt=1, _h=worker.handle: _h(body, attempt, **kw))
    return out


def test_results_are_sent_in_order_and_the_message_deleted(sent, monkeypatch):
    monkeypatch.setattr(worker, "CHUNK_BATCH", 1)  # force several chunk batches
    sqs = FakeSQS([json.dumps(MSG)])
    worker.run("q", sqs=sqs, max_messages=1)
    assert sqs.deleted == ["r0"]
    assert [p["type"] for p in sent] == ["start", "chunks", "chunks", "complete"]
    assert all({p["docId"], p["orgId"], p["kbId"]} == {"doc1", "org1", "kb1"} for p in sent)
    chunks = [c for p in sent if p["type"] == "chunks" for c in p["chunks"]]
    assert [c["index"] for c in chunks] == [0, 1] and all(len(c["embedding"]) == 8 for c in chunks)
    done = sent[-1]
    assert done["chunkCount"] == 2 and "[PERSON_1]" in done["markdown"] and "Rahul" not in done["markdown"]
    assert all(c["text"] in done["markdown"] for c in chunks)


def test_failure_is_reported_kept_for_retry_and_never_logs_signed_urls(sent, monkeypatch, caplog):
    def boom(url, dest, **k):
        raise RuntimeError(f"Client error '403 Forbidden' for url '{url}'")
    monkeypatch.setattr(worker, "download", boom)
    sqs = FakeSQS([json.dumps(MSG)])
    with caplog.at_level(logging.INFO):
        worker.run("q", sqs=sqs, max_messages=1)
    assert sqs.deleted == []
    assert sent == [{"type": "failed", "docId": "doc1", "orgId": "org1", "kbId": "kb1", "final": False,
                     "error": sent[0]["error"]}]
    assert "403 Forbidden" in sent[0]["error"] and "SECRET123" not in sent[0]["error"] + caplog.text


def test_last_attempt_is_reported_as_final(sent, monkeypatch):
    monkeypatch.setattr(worker, "download", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("nope")))
    worker.run("q", sqs=FakeSQS([json.dumps(MSG)], receive_count=worker.MAX_ATTEMPTS), max_messages=1)
    assert sent[-1]["type"] == "failed" and sent[-1]["final"] is True


def test_deleted_document_drops_the_message(monkeypatch):
    def gone(payload):
        raise worker.DocumentGone(payload["docId"])
    monkeypatch.setattr(worker, "download", lambda url, dest, **k: dest.write_text(TRANSCRIPT))
    assert worker.handle(json.dumps(MSG), 1, send=gone, genie=FakeGenie(), embeddings=FakeEmbeddings(),
                         redact_fn=fake_redact) is True


def test_invalid_messages_stay_on_the_queue_without_echoing_the_body(sent, caplog):
    bad = [json.dumps({**MSG, "sourceUrl": "http://insecure/x" + SIGNED}), json.dumps({**MSG, "docId": "../etc"}), "{not json"]
    sqs = FakeSQS(bad)
    with caplog.at_level(logging.INFO):
        worker.run("q", sqs=sqs, max_messages=3)
    assert sqs.deleted == [] and caplog.text.count("invalid message") == 3 and sent == []
    assert "SECRET123" not in caplog.text


def test_results_post_carries_the_secret_and_maps_404_to_document_gone(monkeypatch):
    seen = []
    def fake_post(url, json, headers, timeout):
        seen.append((url, headers["x-internal-secret"]))
        return httpx.Response(404 if json["type"] == "complete" else 200, request=httpx.Request("POST", url))
    monkeypatch.setenv("INGESTION_RESULTS_URL", "https://app.test/api/internal/ingestion/results")
    monkeypatch.setenv("INTERNAL_API_SECRET", "s3cret")
    monkeypatch.setattr(httpx, "post", fake_post)
    worker.send_result({"type": "start", "docId": "d"})
    with pytest.raises(worker.DocumentGone):
        worker.send_result({"type": "complete", "docId": "d"})
    assert seen[0] == ("https://app.test/api/internal/ingestion/results", "s3cret")


def test_real_download_never_logs_its_signed_url(tmp_path, caplog, monkeypatch):
    monkeypatch.setattr(httpx, "stream", lambda *a, **k: httpx.Client(transport=httpx.MockTransport(
        lambda req: httpx.Response(200, content=b"hello"))).stream(*a, **k))
    with caplog.at_level(logging.DEBUG):
        worker.download(MSG["sourceUrl"], tmp_path / "f.md")
    assert (tmp_path / "f.md").read_bytes() == b"hello" and "SECRET123" not in caplog.text


FETCH = {"type": "fetch", "docId": "vid1", "orgId": "org1", "kbId": "kb1",
         "url": "https://www.youtube.com/watch?v=7H9AfVyuliU", "uploadUrl": "https://bucket.s3.amazonaws.com/raw/v.mp4" + SIGNED}


def test_fetch_downloads_uploads_then_reports_fetched(tmp_path):
    steps, sent = [], []

    def download(url, out_dir):
        steps.append(("download", url))
        (out_dir / "video.mp4").write_bytes(b"\x00" * 1234)
        return out_dir / "video.mp4", 72.0

    def upload(url, path):
        steps.append(("upload", url.split("?")[0], path.stat().st_size))

    assert worker.handle(json.dumps(FETCH), 1, send=sent.append, download=download, upload=upload) is True
    assert steps == [("download", FETCH["url"]), ("upload", "https://bucket.s3.amazonaws.com/raw/v.mp4", 1234)]
    assert sent == [{"type": "fetched", "docId": "vid1", "orgId": "org1", "kbId": "kb1", "size": 1234, "durationSeconds": 72.0}]


def test_fetch_failure_is_reported_and_retried(caplog):
    sent = []
    def download(url, out_dir):
        raise RuntimeError("yt-dlp failed: ERROR: [youtube] 7H9AfVyuliU: Sign in to confirm you're not a bot")
    with caplog.at_level(logging.INFO):
        assert worker.handle(json.dumps(FETCH), 1, send=sent.append, download=download, upload=lambda *a: None) is False
    assert sent[0]["type"] == "failed" and "not a bot" in sent[0]["error"] and "SECRET123" not in caplog.text


@pytest.mark.parametrize("url", ["https://evil.example/watch?v=x", "http://www.youtube.com/watch?v=x", "file:///etc/passwd"])
def test_fetch_only_accepts_https_youtube_or_loom(url):
    with pytest.raises(ValueError, match="invalid message"):
        worker.parse(json.dumps({**FETCH, "url": url}))


def test_messages_without_a_type_are_still_processed():
    assert type(worker.parse(json.dumps(MSG))).__name__ == "Job"
    assert type(worker.parse(json.dumps(FETCH))).__name__ == "FetchJob"
