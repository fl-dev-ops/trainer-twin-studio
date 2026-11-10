"""Voices registered with the model server at runtime — no restart per voice.

New or changed voices are uploaded in the background on first use (that request
is served inline). Later requests name the voice, so the model server reuses its
cached encoded features (requires the bundled vLLM-Omni speaker-cache patch for
voices with a transcript). Uploads persist in SPEAKER_SAMPLES_DIR across restarts.
"""
import asyncio
import hashlib
import logging
import time

import httpx

from . import config

logger = logging.getLogger(__name__)

PREFIX = "tt-"
MAX_REFERENCE_BYTES = 25 * 1024 * 1024
RETRY_AFTER_SECONDS = 300.0


def runtime_name(voice_id: str, meta: dict) -> str:
    key = "\0".join((voice_id, meta["version"], meta.get("transcript") or "", config.VOXCPM_MODEL_REVISION))
    return f"{PREFIX}{voice_id.lower()}-{hashlib.sha256(key.encode()).hexdigest()[:16]}"


class RuntimeVoices:
    def __init__(self, backend: httpx.AsyncClient, audio_http: httpx.AsyncClient):
        self.backend, self.audio_http = backend, audio_http
        self.names: set[str] = set()
        self._tasks: dict[str, asyncio.Task] = {}
        self._failed_at: dict[str, float] = {}
        self._uploads = asyncio.Semaphore(2)

    def select(self, voice_id: str, meta: dict) -> str | None:
        if not meta.get("version"):
            return None
        name = runtime_name(voice_id, meta)
        return name if name in self.names else None

    async def sync(self) -> None:
        """Learn which voices the (possibly restarted) model server already has."""
        response = await self.backend.get("/v1/audio/voices", timeout=10)
        response.raise_for_status()
        self.names = {v["name"] for v in response.json().get("uploaded_voices", [])
                      if v.get("name", "").startswith(PREFIX)}

    def ensure(self, voice_id: str, meta: dict) -> None:
        """Register this voice version in the background unless known, pending or recently failed."""
        if not meta.get("version"):
            return  # unversioned voices cannot be cached safely; stay inline
        name = runtime_name(voice_id, meta)
        if name in self.names or name in self._tasks:
            return
        if time.monotonic() - self._failed_at.get(name, -RETRY_AFTER_SECONDS) < RETRY_AFTER_SECONDS:
            return
        task = asyncio.create_task(self._register(voice_id, meta, name))
        self._tasks[name] = task
        task.add_done_callback(lambda _: self._tasks.pop(name, None))

    async def _register(self, voice_id: str, meta: dict, name: str) -> None:
        async with self._uploads:
            try:
                audio = bytearray()
                # The app credential is never sent to the reference-audio host.
                async with self.audio_http.stream("GET", meta["audioUrl"]) as r:
                    r.raise_for_status()
                    async for piece in r.aiter_bytes():
                        audio.extend(piece)
                        if len(audio) > MAX_REFERENCE_BYTES:
                            raise ValueError("Reference audio exceeds 25 MiB")
                if not audio:
                    raise ValueError("Empty reference audio")
                data = {"name": name, "consent": "trainertwin"}
                if meta.get("transcript"):
                    data["ref_text"] = meta["transcript"]
                r = await self.backend.post("/v1/audio/voices", data=data, timeout=120,
                                            files={"audio_sample": ("reference.wav", bytes(audio), "audio/wav")})
                r.raise_for_status()
                self.names.add(name)
                self._failed_at.pop(name, None)
                logger.info("Registered runtime voice for %s", voice_id)
                # Remove superseded versions of this voice so uploads do not accumulate.
                stale_prefix = f"{PREFIX}{voice_id.lower()}-"
                for old in [n for n in self.names if n.startswith(stale_prefix) and n != name]:
                    if (await self.backend.delete(f"/v1/audio/voices/{old}", timeout=30)).status_code in (200, 404):
                        self.names.discard(old)
            except (httpx.HTTPError, ValueError) as cause:
                # Error text can contain signed URLs: log the type only.
                self._failed_at[name] = time.monotonic()
                logger.warning("Runtime voice registration failed for %s: %s", voice_id, type(cause).__name__)

    async def close(self) -> None:
        tasks = list(self._tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
