"""TTS builder. Speech is VoxCPM2 only."""

from __future__ import annotations

import os
from typing import Any

from tts.sentence_flush import with_idle_sentence_flush
from tts.voxcpm2 import VoxCPM2TTS, build_voxcpm2_tts


def build_tts(*, voice: str = "") -> Any:
    engine = build_voxcpm2_tts(voice=voice)
    # 0 disables it (LiveKit's default splitter then holds the last sentence until the LLM stream ends).
    idle_flush_ms = float(os.getenv("TTS_IDLE_FLUSH_MS", "200"))
    return with_idle_sentence_flush(engine, idle_flush_s=idle_flush_ms / 1000) if idle_flush_ms > 0 else engine


__all__ = ["VoxCPM2TTS", "build_tts", "build_voxcpm2_tts"]
