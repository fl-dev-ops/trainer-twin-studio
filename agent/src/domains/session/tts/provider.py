"""TTS provider configuration and selection."""

from __future__ import annotations

import logging
import os

logger = logging.getLogger(__name__)

DEFAULT_SARVAM_LANGUAGE = "en-IN"
DEFAULT_SARVAM_TTS_MODEL = "bulbul:v3"

_SARVAM_POOL_MAX_SESSION_DURATION = 50.0


def build_sarvam_tts(
    *,
    tts_speaker: str,
    tts_dict_id: str | None,
    tts_model: str,
    session_config: Any,
) -> Any:
    from livekit.plugins import sarvam

    tts = sarvam.TTS(
        target_language_code=DEFAULT_SARVAM_LANGUAGE,
        model=tts_model,
        speaker=session_config.voice or tts_speaker,
        pace=session_config.speaking_speed or 1.0,
        temperature=0.6,
        enable_preprocessing=True,
        output_audio_bitrate="128k",
        min_buffer_size=50,
        max_chunk_length=150,
        dict_id=session_config.dict_id or tts_dict_id,
    )
    if hasattr(tts, "prewarm"):
        tts.prewarm()
    if hasattr(tts, "_pool"):
        tts._pool._max_session_duration = _SARVAM_POOL_MAX_SESSION_DURATION
        tts._pool._mark_refreshed_on_get = True
    return tts


def build_tts(
    *,
    tts_speaker: str,
    tts_dict_id: str | None,
    tts_model: str,
    session_config: Any,
) -> Any:
    provider = os.getenv("TTS_PROVIDER", "voxcpm2").strip().lower()
    if provider == "voxcpm2":
        from interfaces.tts.voxcpm2 import build_voxcpm2_tts

        return build_voxcpm2_tts(session_config=session_config)
    if provider == "sarvam":
        return build_sarvam_tts(
            tts_speaker=tts_speaker,
            tts_dict_id=tts_dict_id,
            tts_model=tts_model,
            session_config=session_config,
        )
    raise ValueError("TTS_PROVIDER must be either 'sarvam' or 'voxcpm2'")


def validate_tts_provider_configuration() -> None:
    provider = os.getenv("TTS_PROVIDER", "voxcpm2").strip().lower()
    if provider == "voxcpm2":
        from interfaces.tts.voxcpm2 import validate_voxcpm2_configuration

        validate_voxcpm2_configuration()
    elif provider == "sarvam":
        pass
    else:
        raise ValueError("TTS_PROVIDER must be either 'sarvam' or 'voxcpm2'")
