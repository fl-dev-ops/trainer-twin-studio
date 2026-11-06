"""Knowledge ingestion: any file -> redacted markdown -> LLM topic chunks -> embeddings -> Chroma.

  FileFetcher -> redacted_markdown chef -> SlumberChunker (Qwen) -> merge_small -> EmbeddingsRefinery -> JSON porter

Per input file it leaves <out>/<docId>.md (redacted markdown) and <out>/<docId>.chunks.jsonl
(chunks with embeddings). The SQS worker (worker.py) sends both to the web app, which stores them.
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
from typing import Any, Optional

from chonkie import LiteLLMEmbeddings, Pipeline

from .chef import RedactedMarkdownChef  # registers "redacted_markdown"
from .genie import OpenRouterGenie
from .refinery import MergeSmallRefinery  # registers "merge_small"

OPENROUTER = "https://openrouter.ai/api/v1"
CHUNK_MODEL = os.environ.get("CHUNK_MODEL", "qwen/qwen3.8-27b")
EMBEDDING_MODEL = os.environ.get("EMBEDDING_MODEL", "openai/text-embedding-3-small")  # what the web app queries with
CHUNK_WORDS = 1000  # Slumber window = max chunk size; lab guide: most chunks 250-900 words
CHUNKING_VERSION = f"slumber-{CHUNK_MODEL.split('/')[-1]}-{CHUNK_WORDS}w-v1"


def default_genie() -> OpenRouterGenie:
    return OpenRouterGenie(model=CHUNK_MODEL, base_url=OPENROUTER, api_key=os.environ["OPENROUTER_API_KEY"])


def default_embeddings() -> LiteLLMEmbeddings:
    # Chonkie's OpenAIEmbeddings is hard-wired to api.openai.com (catsu); LiteLLM takes an api_base.
    return LiteLLMEmbeddings(model=f"openai/{EMBEDDING_MODEL}", api_base=OPENROUTER,
                             api_key=os.environ["OPENROUTER_API_KEY"])


def doc_id_for(path: Path) -> str:
    """Same bytes -> same id, so re-ingesting a file is idempotent."""
    with path.open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()[:16]


def build_pipeline(path: Path, out_dir: Path, meta: dict[str, Any], *, genie: Any, embeddings: Any,
                   redact_fn: Any = None, convert_fn: Any = None) -> Pipeline:
    doc_meta = {"type": "knowledge", "chunkingVersion": CHUNKING_VERSION, **meta}
    return (Pipeline()
         .fetch_from("file", path=str(path))
         .process_with("redacted_markdown", out_dir=str(out_dir), doc_meta=doc_meta, redact_fn=redact_fn,
                       convert_fn=convert_fn)
         .chunk_with("slumber", genie=genie, tokenizer="word", chunk_size=CHUNK_WORDS, max_retries=2, verbose=False)
         .refine_with("merge_small")
         .refine_with("embeddings", embedding_model=embeddings)
         .export_with("json", file=str(out_dir / f"{doc_meta['docId']}.chunks.jsonl")))


def ingest_file(path: Path, out_dir: Path, meta: Optional[dict[str, Any]] = None, *, genie: Any = None,
                embeddings: Any = None, **kw: Any) -> str:
    """Runs one file end to end and returns its docId. Raises on any failed step."""
    meta = {"docId": doc_id_for(path), **(meta or {})}  # no file name: it can hold names and lands in the .md
    build_pipeline(path, out_dir, meta, genie=genie or default_genie(), embeddings=embeddings or default_embeddings(), **kw).run()
    return meta["docId"]


__all__ = ["ingest_file", "build_pipeline", "default_genie", "default_embeddings", "doc_id_for",
           "RedactedMarkdownChef", "MergeSmallRefinery", "CHUNKING_VERSION"]
