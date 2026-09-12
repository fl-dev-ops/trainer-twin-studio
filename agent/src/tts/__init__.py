"""TTS provider builder."""

from __future__ import annotations

import os
from typing import Any

from tts.voxcpm2 import VoxCPM2TTS, build_voxcpm2_tts


def build_tts(*, voice: str = "", speaker: str = "rohan") -> Any:
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
