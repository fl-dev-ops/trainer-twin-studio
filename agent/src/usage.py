"""Live usage reporting: running totals posted to the web ledger (POST /api/internal/usage).

Posts cumulative totals (snapshots), never increments: the server stores only the increase,
so a lost or retried post loses or double-counts nothing. LLM tokens of the voice brain are
NOT reported here — the chat service (eve) records those per model call.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

import aiohttp
from livekit import rtc

logger = logging.getLogger(__name__)

Key = tuple[str, str, str]  # (provider, model, metric)

FLUSH_INTERVAL_S = 10.0
POST_TIMEOUT_S = 5.0


def _is_learner(participant: Any) -> bool:
    # Egress/agent/SIP participants must not count as conversation time.
    return getattr(participant, "kind", rtc.ParticipantKind.PARTICIPANT_KIND_STANDARD) == (
        rtc.ParticipantKind.PARTICIPANT_KIND_STANDARD
    )


class UsageReporter:
    def __init__(self, *, session_id: str, stream_id: str, url: str, secret: str) -> None:
        self.session_id = session_id
        self.stream_id = stream_id
        self.url = url
        self.secret = secret
        self.totals: dict[Key, float] = {}
        self._sent: dict[Key, float] = {}
        self._seq = 0
        self._lock = asyncio.Lock()
        self._connected = 0.0
        self._present_since: float | None = None
        self._task: asyncio.Task[None] | None = None

    # ---- collection (sync, memory only) ----

    def on_session_usage(self, usage: Any) -> None:
        """LiveKit `session_usage_updated` / `session.usage`: cumulative per provider+model."""
        for u in getattr(usage, "model_usage", None) or []:
            kind = getattr(u, "type", "")
            if kind == "stt_usage":
                self.totals[(u.provider, u.model, "stt_seconds")] = float(u.audio_duration)
            elif kind == "tts_usage":
                self.totals[(u.provider, u.model, "tts_characters")] = float(u.characters_count)
                self.totals[(u.provider, u.model, "tts_seconds")] = float(u.audio_duration)
            # llm_usage: skipped on purpose, counted by the chat service

    def add_llm_usage(self, provider: str, model: str, usage: Any) -> None:
        """Our own running counter for LLM calls outside the AgentSession (screen vision)."""
        if usage is None:
            return
        for metric, value in (
            ("input_tokens", getattr(usage, "prompt_tokens", 0)),
            ("output_tokens", getattr(usage, "completion_tokens", 0)),
            ("cache_read_tokens", getattr(usage, "prompt_cached_tokens", 0)),
        ):
            key = (provider, model, metric)
            self.totals[key] = self.totals.get(key, 0.0) + float(value or 0)

    def participants_changed(self, room: Any) -> None:
        """Conversation clock runs only while a learner is in the room."""
        present = any(_is_learner(p) for p in room.remote_participants.values())
        now = time.monotonic()
        if present and self._present_since is None:
            self._present_since = now
        elif not present and self._present_since is not None:
            self._connected += now - self._present_since
            self._present_since = None

    def connected_seconds(self) -> float:
        live = time.monotonic() - self._present_since if self._present_since is not None else 0.0
        return self._connected + live

    # ---- delivery ----

    async def flush(self) -> bool:
        async with self._lock:  # loop + final flush never post concurrently (server cursor relies on it)
            connected = self.connected_seconds()
            if connected > 0:
                self.totals[("livekit", "room", "connected_seconds")] = round(connected, 3)
            snapshot = {k: v for k, v in self.totals.items() if v > 0}
            if not snapshot or snapshot == self._sent:
                return True
            self._seq += 1
            payload = {
                "kind": "snapshot",
                "source": "voice_agent",
                "sessionId": self.session_id,
                "streamId": self.stream_id,
                "seq": self._seq,
                "totals": [
                    {"provider": p, "model": m, "metric": metric, "value": value}
                    for (p, m, metric), value in sorted(snapshot.items())
                ],
            }
            try:
                async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=POST_TIMEOUT_S)) as http:
                    async with http.post(
                        self.url, json=payload, headers={"Authorization": f"Bearer {self.secret}"}
                    ) as resp:
                        if resp.status >= 400:
                            logger.warning(
                                "[usage] post rejected session=%s status=%s body=%s",
                                self.session_id, resp.status, (await resp.text())[:200],
                            )
                            return False
            except Exception as exc:  # next flush resends newer totals
                logger.warning("[usage] post failed session=%s error=%s", self.session_id, exc)
                return False
            self._sent = snapshot
            return True

    def start(self, interval: float = FLUSH_INTERVAL_S) -> None:
        async def loop() -> None:
            while True:
                await asyncio.sleep(interval)
                await self.flush()

        self._task = asyncio.create_task(loop())

    async def close(self, final_usage: Any = None) -> None:
        """Final snapshot at session end. Stops the loop first so the final post is the last one."""
        if self._task is not None:
            self._task.cancel()
            self._task = None
        if final_usage is not None:
            self.on_session_usage(final_usage)
        if self._present_since is not None:
            self._connected += time.monotonic() - self._present_since
            self._present_since = None
        await self.flush()
