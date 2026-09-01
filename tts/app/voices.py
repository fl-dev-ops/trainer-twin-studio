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

import httpx

from . import config


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
    """Resolve voice IDs to (presigned URL, transcript) via the app server."""

    def __init__(self, http: httpx.AsyncClient):
        self.http = http

    async def resolve(self, voice_id: str) -> dict:
        """Return {"audioUrl": ..., "transcript": ...|None} for this voice."""
        try:
            response = await self.http.get(f"/api/tts/voices/{voice_id}")
        except httpx.HTTPError as cause:
            raise AppUnreachable(f"app server unreachable: {cause}") from cause
        if response.status_code == 404:
            raise VoiceNotFound(f"unknown voice: {voice_id}")
        if response.status_code != 200:
            raise AppUnreachable(f"app server returned {response.status_code}")
        meta = response.json()
        if not meta.get("audioUrl"):
            raise VoiceNotFound(f"voice {voice_id} has no reference audio")
        return {"audioUrl": meta["audioUrl"], "transcript": meta.get("transcript") or None}

    async def list_ids(self) -> list[dict]:
        try:
            response = await self.http.get("/api/tts/voices")
            response.raise_for_status()
        except httpx.HTTPError as cause:
            raise AppUnreachable(f"app server unreachable: {cause}") from cause
        return response.json().get("voices", [])
