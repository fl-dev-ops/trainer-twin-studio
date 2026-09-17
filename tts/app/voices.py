"""Voice reference resolution.

Voice identity lives in the Next.js app (Prisma), not in storage names —
so two users naming a voice the same thing can never collide. This service
only knows opaque voice IDs and asks the app to resolve them:

    GET {APP_BASE_URL}/api/tts/voices/{voiceId}      Bearer APP_API_KEY
    <- {"id","name","version","audioUrl","transcript"}

`audioUrl` is a short-lived presigned S3 URL, passed straight through to
vLLM-Omni as `ref_audio` (it accepts HTTP URLs and caches them itself).
New or updated voices are picked up on the next request — no restarts.
"""

import logging
import time
from typing import Any

import httpx

from . import config

logger = logging.getLogger(__name__)


class VoiceNotFound(Exception):
    pass


class AppUnreachable(Exception):
    pass


def client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        base_url=config.APP_BASE_URL,
        headers={"Authorization": f"Bearer {config.APP_API_KEY}"},
        timeout=30.0,
    )


class VoiceStore:
    """Resolve voice IDs to (presigned URL, transcript) via the app server.

    Caches resolved voice metadata in-memory for `cache_ttl` seconds (default 5m).
    This serves two latency goals:
      1. Drops the 200–600ms Next.js HTTP/DB hop to 0ms on warm turns.
      2. Keeps the `ref_audio` URL string stable across turns so vLLM's internal
         audio decoding cache hits instead of re-downloading from S3.
    """

    def __init__(self, http: httpx.AsyncClient, cache_ttl: float | None = None):
        self.http = http
        self.cache_ttl = cache_ttl if cache_ttl is not None else getattr(config, "VOICE_CACHE_TTL_SECONDS", 300.0)
        self._cache: dict[str, tuple[float, dict[str, Any]]] = {}

    async def resolve(self, voice_id: str) -> dict:
        """Return {"audioUrl": ..., "transcript": ...|None} for this voice."""
        now = time.monotonic()
        cached = self._cache.get(voice_id)
        if cached is not None:
            expires_at, meta = cached
            if expires_at > now:
                logger.debug("voice cache hit voice_id=%s (expires in %.1fs)", voice_id, expires_at - now)
                return meta
            logger.debug("voice cache expired voice_id=%s", voice_id)

        try:
            response = await self.http.get(f"/api/tts/voices/{voice_id}")
        except httpx.HTTPError as cause:
            if cached is not None:
                logger.warning("app server unreachable, using stale voice cache for %s: %s", voice_id, cause)
                return cached[1]
            raise AppUnreachable(f"app server unreachable: {cause}") from cause

        if response.status_code == 404:
            self._cache.pop(voice_id, None)
            raise VoiceNotFound(f"unknown voice: {voice_id}")
        if response.status_code != 200:
            if cached is not None:
                logger.warning("app server returned %d, using stale voice cache for %s", response.status_code, voice_id)
                return cached[1]
            raise AppUnreachable(f"app server returned {response.status_code}")

        meta = response.json()
        if not meta.get("audioUrl"):
            raise VoiceNotFound(f"voice {voice_id} has no reference audio")

        result = {"audioUrl": meta["audioUrl"], "transcript": meta.get("transcript") or None}
        if self.cache_ttl > 0:
            self._cache[voice_id] = (now + self.cache_ttl, result)
        return result

    async def list_ids(self) -> list[dict]:
        try:
            response = await self.http.get("/api/tts/voices")
            response.raise_for_status()
        except httpx.HTTPError as cause:
            raise AppUnreachable(f"app server unreachable: {cause}") from cause
        return response.json().get("voices", [])

    def invalidate(self, voice_id: str | None = None) -> None:
        """Invalidate a specific voice ID or all cached voices."""
        if voice_id:
            self._cache.pop(voice_id, None)
        else:
            self._cache.clear()
