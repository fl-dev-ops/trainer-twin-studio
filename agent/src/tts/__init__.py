"""TTS provider builder."""

from __future__ import annotations

import os
from typing import Any

from tts.sentence_flush import with_idle_sentence_flush
from tts.voxcpm2 import VoxCPM2TTS, build_voxcpm2_tts


def build_tts(*, voice: str = "", speaker: str = "rohan") -> Any:
    engine = _build_engine(voice=voice, speaker=speaker)
    # 0 disables it (LiveKit's default splitter then holds the last sentence until the LLM stream ends).
    idle_flush_ms = float(os.getenv("TTS_IDLE_FLUSH_MS", "200"))
    return with_idle_sentence_flush(engine, idle_flush_s=idle_flush_ms / 1000) if idle_flush_ms > 0 else engine


def _build_engine(*, voice: str, speaker: str) -> Any:
    # Sarvam is the active provider; the voxcpm2 voice-cloning path is kept for later use.
    provider = os.getenv("TTS_PROVIDER", "sarvam").strip().lower()
    if provider == "sarvam":
        from livekit.plugins import sarvam

        return sarvam.TTS(
            target_language_code="en-IN",
            model=os.getenv("SARVAM_TTS_MODEL", "bulbul:v3"),
            speaker=os.getenv("SARVAM_SPEAKER", speaker),
        )

    return build_voxcpm2_tts(voice=voice)


__all__ = ["VoxCPM2TTS", "build_tts", "build_voxcpm2_tts"]
