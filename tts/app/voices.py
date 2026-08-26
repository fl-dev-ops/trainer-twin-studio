"""Voice reference resolution.

Voice identity lives in the Next.js app (Prisma), not in storage names —
so two users naming a voice the same thing can never collide. This service
only knows opaque voice IDs and asks the app to resolve them:

    GET {APP_BASE_URL}/api/tts/voices/{voiceId}      Bearer APP_API_KEY
    <- {"id","name","version","audioUrl","transcript"}

`audioUrl` is a short-lived presigned S3 URL. `version` changes whenever the
reference changes, so reference clips are cached locally keyed by
(id, version) and re-downloaded only when the app reports a new version.
"""

import logging
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path

import httpx

from . import config

logger = logging.getLogger(__name__)

RESOLVE_TIMEOUT = 10.0  # seconds; presigned-URL fetches use the same client


class VoiceNotFound(Exception):
    pass


class AppUnreachable(Exception):
    pass


@dataclass
class VoiceRef:
    wav_path: Path
    transcript: str | None  # exact transcript of the reference clip


def _client() -> httpx.Client:
    return httpx.Client(
        base_url=config.APP_BASE_URL,
        headers={"Authorization": f"Bearer {config.APP_API_KEY}"},
        timeout=30.0,
    )


class VoiceStore:
    def __init__(self, cache_dir: Path):
        self.cache_dir = cache_dir
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        # ponytail: one process-wide client + in-memory version map; fine for
        # the single uvicorn worker a GPU model implies. Add locking or move
        # the manifest to disk if you ever run multiple workers.
        self.http = _client()
        # plain client for presigned S3 fetches — no auth header: S3 rejects
        # presigned URLs when a bearer header is also present
        self.s3 = httpx.Client(timeout=120.0)
        self._versions: dict[str, str] = {}
        self._transcripts: dict[str, str | None] = {}

    def resolve(self, voice_id: str) -> dict:
        """Ask the app server for this voice's current reference metadata."""
        try:
            response = self.http.get(f"/api/tts/voices/{voice_id}")
        except httpx.HTTPError as cause:
            raise AppUnreachable(f"app server unreachable: {cause}") from cause
        if response.status_code == 404:
            raise VoiceNotFound(f"unknown voice: {voice_id}")
        if response.status_code != 200:
            raise AppUnreachable(f"app server returned {response.status_code}")
        return response.json()

    def get(self, voice_id: str) -> VoiceRef:
        meta = self.resolve(voice_id)
        version = str(meta.get("version", ""))
        wav_path = self.cache_dir / f"{voice_id}.{version}.wav"

        if not wav_path.exists():
            logger.info("downloading reference for voice %s (version %s)", voice_id, version)
            audio = self.s3.get(meta["audioUrl"])
            audio.raise_for_status()
            # unique tmp name: concurrent first requests for the same voice
            # must not clobber each other's in-flight download
            fd, tmp_name = tempfile.mkstemp(dir=self.cache_dir, suffix=".tmp")
            tmp = Path(tmp_name)
            try:
                with os.fdopen(fd, "wb") as f:
                    f.write(audio.content)
                tmp.replace(wav_path)
            except BaseException:
                tmp.unlink(missing_ok=True)
                raise
            # keep only the newest version of this voice around
            for old in self.cache_dir.glob(f"{voice_id}.*.wav"):
                if old != wav_path:
                    old.unlink(missing_ok=True)

        self._versions[voice_id] = version
        transcript = meta.get("transcript") or None
        self._transcripts[voice_id] = transcript
        return VoiceRef(wav_path=wav_path, transcript=transcript)

    async def list_ids(self) -> list[dict]:
        try:
            response = self.http.get("/api/tts/voices")
            response.raise_for_status()
        except httpx.HTTPError as cause:
            raise AppUnreachable(f"app server unreachable: {cause}") from cause
        return response.json().get("voices", [])
