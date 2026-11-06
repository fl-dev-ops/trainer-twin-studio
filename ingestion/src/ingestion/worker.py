"""SQS worker for knowledge-base uploads. One message = one uploaded file.

The worker has no Postgres, S3 or Chroma access. It downloads the file from a signed URL, runs the
pipeline and POSTs the results to the web app (INGESTION_RESULTS_URL), which stores the files in S3 and
writes the chunks to the org's Chroma database.

Message body (sent by web/lib/ingestion-queue.ts):
  {"docId": "...", "orgId": "...", "kbId": "...", "filename": "lesson.m4a", "sourceUrl": "https://..."}

Results, each a POST with header x-internal-secret (Vercel caps a request at 4.5 MB, hence batches):
  {"type": "start", ids}                                    worker has the results; web clears old chunk files
  {"type": "chunks", ids, "batch": n, "chunkingVersion", "chunks": [{"index", "text", "startIndex", "endIndex",
   "tokenCount", "embedding"}]}                             <= CHUNK_BATCH chunks each
  {"type": "complete", ids, "markdown", "chunkCount", "chunkingVersion"}
  {"type": "failed", ids, "error", "final"}                 final = no SQS retry left
Every step is idempotent, so an SQS retry is safe. A 404 means the document was deleted: drop the message.
Signed URLs are credentials: they are never logged.
"""
from __future__ import annotations

import json
import logging
import os
import re
import signal
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Callable, Optional
from urllib.parse import urlparse

import httpx
from pydantic import BaseModel, Field, ValidationError, field_validator

from . import CHUNKING_VERSION, build_pipeline, default_embeddings, default_genie

log = logging.getLogger("ingestion.worker")
# httpx logs every request URL at INFO, which would print signed URLs.
for _name in ("httpx", "httpcore"):
    logging.getLogger(_name).setLevel(logging.WARNING)

MAX_DOWNLOAD_BYTES = 2_000_000_000  # AssemblyAI rejects uploads over 2.2 GB
MAX_MARKDOWN_BYTES = 3_500_000      # "complete" carries the markdown; Vercel's request limit is 4.5 MB
CHUNK_BATCH = 50                    # ~1.5 MB per request with 1536-float embeddings
VISIBILITY_SECONDS = 300            # extended every half period while a file is being processed
MAX_ATTEMPTS = int(os.environ.get("INGESTION_MAX_RECEIVE_COUNT", "5"))  # match the queue's redrive maxReceiveCount


class DocumentGone(Exception):
    """The web app no longer has this document (deleted while queued)."""


class Job(BaseModel):
    docId: str = Field(pattern=r"^[A-Za-z0-9_-]{1,128}$")
    orgId: str = Field(min_length=1)
    kbId: str = Field(min_length=1)
    filename: str = Field(min_length=1)
    sourceUrl: str

    @field_validator("sourceUrl")
    @classmethod
    def https_only(cls, v: str) -> str:
        if urlparse(v).scheme != "https":
            raise ValueError("must be an https URL")
        return v

    @property
    def ids(self) -> dict[str, str]:
        return {"docId": self.docId, "orgId": self.orgId, "kbId": self.kbId}


def download(url: str, dest: Path, max_bytes: int = MAX_DOWNLOAD_BYTES) -> None:
    size = 0
    with httpx.stream("GET", url, follow_redirects=True, timeout=httpx.Timeout(60, read=300)) as r:
        r.raise_for_status()
        with dest.open("wb") as f:
            for part in r.iter_bytes(1 << 20):
                size += len(part)
                if size > max_bytes:
                    raise ValueError(f"source is larger than {max_bytes} bytes")
                f.write(part)
    if size == 0:
        raise ValueError("source is empty")


def send_result(payload: dict[str, Any]) -> None:
    r = httpx.post(os.environ["INGESTION_RESULTS_URL"], json=payload, timeout=120,
                   headers={"x-internal-secret": os.environ["INTERNAL_API_SECRET"]})
    if r.status_code == 404:
        raise DocumentGone(payload["docId"])
    r.raise_for_status()


def process(job: Job, *, send: Callable[[dict[str, Any]], None] = send_result, genie: Any = None,
            embeddings: Any = None, **pipeline_kw: Any) -> int:
    """Runs one job end to end and reports it. Returns the chunk count; raises on any failure."""
    with tempfile.TemporaryDirectory(prefix="ingest-") as tmp:
        src = Path(tmp) / ("source" + Path(job.filename).suffix.lower())
        out = Path(tmp) / "out"
        t = time.monotonic()
        download(job.sourceUrl, src)
        doc = build_pipeline(src, out, {**job.ids}, genie=genie or default_genie(),
                             embeddings=embeddings or default_embeddings(), **pipeline_kw).run()
        markdown = (out / f"{job.docId}.md").read_text(encoding="utf-8")
        if len(markdown.encode()) > MAX_MARKDOWN_BYTES:
            raise ValueError(f"redacted markdown is over {MAX_MARKDOWN_BYTES} bytes")
        rows = [{"index": i, "text": c.text, "startIndex": c.start_index, "endIndex": c.end_index,
                 "tokenCount": c.token_count, "embedding": [float(x) for x in c.embedding]}
                for i, c in enumerate(doc.chunks)]
        send({"type": "start", **job.ids})
        for b in range(0, len(rows), CHUNK_BATCH):
            send({"type": "chunks", **job.ids, "batch": b // CHUNK_BATCH, "chunkingVersion": CHUNKING_VERSION,
                  "chunks": rows[b:b + CHUNK_BATCH]})
        send({"type": "complete", **job.ids, "markdown": markdown, "chunkCount": len(rows),
              "chunkingVersion": CHUNKING_VERSION})
        log.info("done docId=%s chunks=%d elapsed=%.1fs", job.docId, len(rows), time.monotonic() - t)
        return len(rows)


def _safe(e: BaseException) -> str:
    """Error text without URL query strings: httpx errors embed the (signed) URL."""
    return re.sub(r"(https?://[^\s?'\"]+)\?[^\s'\"]*", r"\1?<redacted>", str(e))[:500]


class _Heartbeat:
    """Keeps the message invisible while a long file (e.g. a transcription) is being processed."""

    def __init__(self, sqs: Any, queue_url: str, receipt: str) -> None:
        self.sqs, self.queue_url, self.receipt = sqs, queue_url, receipt
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        while not self.stop.wait(VISIBILITY_SECONDS / 2):
            try:
                self.sqs.change_message_visibility(QueueUrl=self.queue_url, ReceiptHandle=self.receipt,
                                                   VisibilityTimeout=VISIBILITY_SECONDS)
            except Exception as e:
                log.warning("visibility extension failed: %s", type(e).__name__)

    def __enter__(self) -> "_Heartbeat":
        self.thread.start()
        return self

    def __exit__(self, *exc: Any) -> None:
        self.stop.set()
        self.thread.join()


def parse(body: str) -> Job:
    try:
        return Job.model_validate(json.loads(body))
    except (json.JSONDecodeError, ValidationError) as e:
        # Never echo the body: it holds a signed URL.
        fields = [".".join(map(str, err["loc"])) for err in e.errors()] if isinstance(e, ValidationError) else []
        raise ValueError(f"invalid message {fields}") from None


def handle(body: str, attempt: int = 1, *, send: Callable[[dict[str, Any]], None] = send_result, **kw: Any) -> bool:
    """Processes one message body. Returns True when the message should be deleted."""
    job = parse(body)  # an invalid message raises: it stays on the queue and ends in the DLQ
    log.info("start docId=%s orgId=%s attempt=%d ext=%s", job.docId, job.orgId, attempt, Path(job.filename).suffix)
    try:
        process(job, send=send, **kw)
        return True
    except DocumentGone:
        log.info("document %s was deleted; dropping its message", job.docId)
        return True
    except Exception as e:
        final = attempt >= MAX_ATTEMPTS
        log.error("failed docId=%s attempt=%d final=%s: %s: %s", job.docId, attempt, final, type(e).__name__, _safe(e))
        try:
            send({"type": "failed", **job.ids, "error": f"{type(e).__name__}: {_safe(e)}"[:300], "final": final})
        except DocumentGone:
            return True
        except Exception as report_error:
            log.warning("could not report the failure: %s", type(report_error).__name__)
        return False  # left on the queue -> SQS retries -> DLQ after MAX_ATTEMPTS


def run(queue_url: str, sqs: Any = None, max_messages: Optional[int] = None, **kw: Any) -> None:
    """Long-polls the queue and processes one message at a time until SIGTERM/SIGINT.
    Scale with more worker processes, not threads."""
    import boto3

    sqs = sqs or boto3.client("sqs")
    stopping = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stopping.set())  # finish the current file, then exit
    seen = 0
    while not stopping.is_set() and (max_messages is None or seen < max_messages):
        resp = sqs.receive_message(QueueUrl=queue_url, MaxNumberOfMessages=1, WaitTimeSeconds=20,
                                   VisibilityTimeout=VISIBILITY_SECONDS, AttributeNames=["ApproximateReceiveCount"])
        for m in resp.get("Messages", []):
            seen += 1
            attempt = int(m.get("Attributes", {}).get("ApproximateReceiveCount", "1"))
            with _Heartbeat(sqs, queue_url, m["ReceiptHandle"]):
                try:
                    done = handle(m["Body"], attempt, **kw)
                except Exception as e:  # invalid message
                    log.error("rejected message=%s attempt=%d: %s", m["MessageId"], attempt, _safe(e))
                    done = False
            if done:
                sqs.delete_message(QueueUrl=queue_url, ReceiptHandle=m["ReceiptHandle"])


def main() -> None:
    from dotenv import load_dotenv

    load_dotenv()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    for name in ("INGESTION_QUEUE_URL", "INGESTION_RESULTS_URL", "INTERNAL_API_SECRET", "OPENROUTER_API_KEY"):
        if not os.environ.get(name):
            raise SystemExit(f"{name} is required")
    run(os.environ["INGESTION_QUEUE_URL"])


if __name__ == "__main__":
    main()
