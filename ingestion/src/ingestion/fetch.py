"""Fetch stage: download a video page (YouTube, Loom) with yt-dlp and PUT the file to S3 through a signed URL.

Runs before the process stage, so the raw file is in our S3 first and a processing retry never
downloads again. yt-dlp needs a JS runtime for YouTube (node by default, or bun via YTDLP_JS_RUNTIME)
and ffmpeg to merge the video and audio streams. Only public/unlisted videos work: no cookies are used.
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

import httpx
from pydantic import BaseModel, Field, field_validator

MAX_VIDEO_BYTES = 2_000_000_000   # AssemblyAI takes up to 2.2 GB; KnowledgeDocument.size is a 32-bit Int
DOWNLOAD_TIMEOUT_S = 3600
FORMAT = "bv*[height<=720]+ba/b[height<=720]/b"   # 720p is plenty for transcription and playback
JS_RUNTIME = os.environ.get("YTDLP_JS_RUNTIME", "node")  # node | bun
ALLOWED_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "loom.com", "www.loom.com"}


class FetchJob(BaseModel):
    type: str = Field(pattern=r"^fetch$")
    docId: str = Field(pattern=r"^[A-Za-z0-9_-]{1,128}$")
    orgId: str = Field(min_length=1)
    kbId: str = Field(min_length=1)
    url: str           # the video page
    uploadUrl: str     # signed S3 PUT for video/mp4

    @field_validator("url")
    @classmethod
    def video_page_only(cls, v: str) -> str:
        u = urlparse(v)
        if u.scheme != "https" or u.hostname not in ALLOWED_HOSTS:
            raise ValueError("only https YouTube or Loom URLs")
        return v

    @field_validator("uploadUrl")
    @classmethod
    def https_only(cls, v: str) -> str:
        if urlparse(v).scheme != "https":
            raise ValueError("must be an https URL")
        return v

    @property
    def ids(self) -> dict[str, str]:
        return {"docId": self.docId, "orgId": self.orgId, "kbId": self.kbId}


def download_video(url: str, out_dir: Path) -> tuple[Path, float | None]:
    """Downloads one video as mp4. Returns (file, duration in seconds)."""
    cmd = [sys.executable, "-m", "yt_dlp", "--no-update", "--no-playlist", "--no-progress",
           "--js-runtimes", JS_RUNTIME, "-f", FORMAT, "--merge-output-format", "mp4",
           "--print", "after_move:%(duration)s", "-o", str(out_dir / "video.%(ext)s"), url]
    if os.environ.get("FFMPEG_LOCATION"):
        cmd[4:4] = ["--ffmpeg-location", os.environ["FFMPEG_LOCATION"]]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=DOWNLOAD_TIMEOUT_S, check=False)
    if r.returncode != 0:
        errors = [line for line in r.stderr.splitlines() if line.startswith("ERROR")] or r.stderr.splitlines()[-1:]
        raise RuntimeError(f"yt-dlp failed: {' '.join(errors)[:300]}")
    files = [p for p in out_dir.glob("video.*") if p.suffix == ".mp4" and p.stat().st_size > 0]
    if len(files) != 1:
        raise RuntimeError("yt-dlp produced no mp4")
    lines = r.stdout.strip().splitlines()
    try:
        duration = float(lines[-1]) if lines else None
    except ValueError:
        duration = None
    return files[0], duration


def upload_video(url: str, path: Path) -> None:
    size = path.stat().st_size
    with path.open("rb") as f:
        r = httpx.put(url, content=f, timeout=httpx.Timeout(60, write=1800),
                      headers={"Content-Type": "video/mp4", "Content-Length": str(size)})
    r.raise_for_status()


def fetch(job: FetchJob, send: Callable[[dict[str, Any]], None],
          download: Callable[[str, Path], tuple[Path, float | None]] = download_video,
          upload: Callable[[str, Path], None] = upload_video) -> int:
    """Download -> PUT to S3 -> report "fetched" (the web app then queues processing). Returns the size."""
    with tempfile.TemporaryDirectory(prefix="fetch-") as tmp:
        path, duration = download(job.url, Path(tmp))
        size = path.stat().st_size
        if size > MAX_VIDEO_BYTES:
            raise ValueError(f"video is larger than {MAX_VIDEO_BYTES} bytes")
        upload(job.uploadUrl, path)
    send({"type": "fetched", **job.ids, "size": size, "durationSeconds": duration})
    return size
