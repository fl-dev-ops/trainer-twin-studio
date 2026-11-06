"""Raw file -> (title, markdown), one strategy per kind of file. No local models.

  text       .md .markdown .txt .json   read as-is; YAML front matter is dropped (its title is kept)
  documents  Word, PowerPoint, Excel, OpenDocument, RTF, EPUB, CSV, PDF
             anydoc (Rust, local). Scanned PDFs go to Firecrawl Parse OCR (FIRECRAWL_API_KEY optional).
  media      audio / video   AssemblyAI with speaker labels -> "speaker_N: ..." turns
  images     .png .jpg .webp  OCR by a vision model on OpenRouter
"""
from __future__ import annotations

import base64
import os
import re
import time
from pathlib import Path
from typing import Callable

import anydoc
import httpx
import yaml

DOCUMENTS = (".pdf", ".doc", ".docx", ".docm", ".ppt", ".pps", ".pot", ".pptx", ".pptm", ".ppsx", ".ppsm",
             ".xls", ".xlsx", ".xlsm", ".xlsb", ".odt", ".ods", ".odp", ".rtf", ".epub", ".csv")
MEDIA = (".mp3", ".m4a", ".wav", ".aac", ".ogg", ".flac", ".mp4", ".mov", ".webm", ".mkv")
IMAGES = (".png", ".jpg", ".jpeg", ".webp")
TEXT = (".md", ".markdown", ".txt", ".json")

ASSEMBLYAI = "https://api.assemblyai.com"
SPEECH_MODEL = "universal-3-5-pro"
TRANSCRIBE_TIMEOUT_S = 3600
OCR_MODEL = os.environ.get("OCR_MODEL", "google/gemini-2.5-flash")
FRONT = re.compile(r"\A\ufeff?---\n(.*?\n)?---\n", re.S)


class UnsupportedFileType(ValueError):
    pass


def text_to_md(text: str, fallback_title: str = "") -> tuple[str, str]:
    m = FRONT.match(text)
    if m:
        try:
            meta = yaml.safe_load(m.group(1) or "") or {}
        except yaml.YAMLError:
            meta = None  # not front matter after all: keep the text whole
        if isinstance(meta, dict):
            return str(meta.get("title") or fallback_title), text[m.end():].strip()
    return fallback_title, text.strip()


def _text(path: Path) -> tuple[str, str]:
    return text_to_md(path.read_text(encoding="utf-8"), path.stem)


def _document(path: Path) -> tuple[str, str]:
    return path.stem, anydoc.to_markdown(path, ocr="hosted")


def _media(path: Path) -> tuple[str, str]:
    with httpx.Client(base_url=ASSEMBLYAI, headers={"authorization": os.environ["ASSEMBLYAI_API_KEY"]},
                      timeout=300) as c:
        with path.open("rb") as f:
            up = c.post("/v2/upload", content=f)
        up.raise_for_status()
        job = c.post("/v2/transcript", json={"audio_url": up.json()["upload_url"], "speech_models": [SPEECH_MODEL],
                                             "speaker_labels": True, "language_detection": True})
        job.raise_for_status()
        tid = job.json()["id"]
        deadline = time.monotonic() + TRANSCRIBE_TIMEOUT_S
        while True:
            data = c.get(f"/v2/transcript/{tid}").raise_for_status().json()
            if data["status"] == "completed":
                break
            if data["status"] == "error" or time.monotonic() > deadline:
                raise RuntimeError(f"transcription {data['status']}: {data.get('error', 'timed out')}")
            time.sleep(3)
        try:
            c.delete(f"/v2/transcript/{tid}")  # don't leave the raw transcript (it holds PII) at AssemblyAI
        except httpx.HTTPError:
            pass
    ids: dict[str, int] = {}
    turns = [f"speaker_{ids.setdefault(u['speaker'], len(ids) + 1)}: {u['text'].strip()}"
             for u in data.get("utterances") or [] if u.get("text", "").strip()]
    return path.stem, "\n\n".join(turns) or (data.get("text") or "")


def _image(path: Path) -> tuple[str, str]:
    mime = {".png": "image/png", ".webp": "image/webp"}.get(path.suffix.lower(), "image/jpeg")
    image = f"data:{mime};base64,{base64.b64encode(path.read_bytes()).decode()}"
    r = httpx.post("https://openrouter.ai/api/v1/chat/completions", timeout=180,
                   headers={"Authorization": f"Bearer {os.environ['OPENROUTER_API_KEY']}"},
                   json={"model": OCR_MODEL, "temperature": 0, "messages": [{"role": "user", "content": [
                       {"type": "text", "text": "Transcribe all text in this image as Markdown, keeping its structure. "
                                                "Return only the transcription; return nothing if there is no text."},
                       {"type": "image_url", "image_url": {"url": image}}]}]})
    r.raise_for_status()
    return path.stem, r.json()["choices"][0]["message"]["content"] or ""


STRATEGIES: dict[str, Callable[[Path], tuple[str, str]]] = {
    **dict.fromkeys(TEXT, _text),
    **dict.fromkeys(DOCUMENTS, _document),
    **dict.fromkeys(MEDIA, _media),
    **dict.fromkeys(IMAGES, _image),
}


def to_markdown(path: Path) -> tuple[str, str]:
    fn = STRATEGIES.get(path.suffix.lower())
    if fn is None:
        raise UnsupportedFileType(f"no markdown strategy for {path.suffix or 'files without extension'}")
    title, md = fn(path)
    if not md.strip():
        raise ValueError(f"{path.name}: conversion produced no text")
    return title, md
