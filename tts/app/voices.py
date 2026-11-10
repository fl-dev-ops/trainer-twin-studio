"""Resolve versioned voice references through the authenticated app API."""
import asyncio
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
    def __init__(self, http: httpx.AsyncClient, cache_ttl: float | None = None):
        self.http = http
        self.cache_ttl = cache_ttl if cache_ttl is not None else config.VOICE_CACHE_TTL_SECONDS
        self._cache: dict[str, tuple[float, dict[str, Any]]] = {}
        self._pending: dict[str, asyncio.Task] = {}

    async def resolve(self, voice_id: str) -> dict:
        cached = self._cache.get(voice_id)
        if cached and cached[0] > time.monotonic():
            return cached[1]
        task = self._pending.get(voice_id)
        if task is None:
            task = asyncio.create_task(self._fetch(voice_id))
            self._pending[voice_id] = task

            def finished(done):
                self._pending.pop(voice_id, None)
                if not done.cancelled():
                    done.exception()  # Observe failures even if every waiting caller disconnected.

            task.add_done_callback(finished)
        return await asyncio.shield(task)

    async def _fetch(self, voice_id: str) -> dict:
        try:
            response = await self.http.get(f"/api/tts/voices/{voice_id}")
        except httpx.HTTPError as cause:
            raise AppUnreachable("Voice service unavailable") from cause
        if response.status_code == 404:
            self.invalidate(voice_id)
            raise VoiceNotFound("Unknown voice")
        if response.status_code != 200:
            self.invalidate(voice_id)
            raise AppUnreachable("Voice service rejected the request")
        try:
            meta = response.json()
            if not isinstance(meta, dict) or not isinstance(meta.get("audioUrl"), str):
                raise ValueError("Missing reference URL")
            if httpx.URL(meta["audioUrl"]).scheme not in ("http", "https"):
                raise ValueError("Invalid reference URL")
            if meta.get("version") is not None and not isinstance(meta["version"], str):
                raise ValueError("Invalid voice version")
            if meta.get("transcript") is not None and not isinstance(meta["transcript"], str):
                raise ValueError("Invalid transcript")
        except (ValueError, httpx.InvalidURL) as cause:
            raise AppUnreachable("Invalid voice metadata") from cause
        result = {"audioUrl": meta["audioUrl"], "transcript": meta.get("transcript") or None,
                  "version": meta.get("version")}
        if self.cache_ttl > 0:
            self._cache[voice_id] = (time.monotonic() + self.cache_ttl, result)
        return result

    async def list_ids(self) -> list[dict]:
        try:
            response = await self.http.get("/api/tts/voices")
            response.raise_for_status()
            return response.json().get("voices", [])
        except (httpx.HTTPError, ValueError) as cause:
            raise AppUnreachable("Voice service unavailable") from cause

    def invalidate(self, voice_id: str | None = None) -> None:
        if voice_id:
            self._cache.pop(voice_id, None)
        else:
            self._cache.clear()

    async def close(self) -> None:
        tasks = list(self._pending.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
