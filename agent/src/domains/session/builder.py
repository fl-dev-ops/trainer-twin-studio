"""Agent session builder."""

from __future__ import annotations

import logging
from typing import Any

from livekit.agents import (
    AgentSession,
    PreemptiveGenerationOptions,
    TurnHandlingOptions,
)
from livekit.agents.inference import TurnDetector
from livekit.plugins import deepgram, openai

from domains.session.config import InteractionMode, SessionConfig
from domains.session.tts.provider import build_tts

logger = logging.getLogger(__name__)

DEFAULT_LLM_MODEL = "trainertwin-runtime"
DEFAULT_OPENROUTER_MODEL = "openai/gpt-5.5"
DEFAULT_DEEPGRAM_STT_MODEL = "flux-general-en"
DEFAULT_SARVAM_TTS_MODEL = "bulbul:v3"


def build_agent_session(
    *,
    base_url: str | None = None,
    api_key: str | None = None,
    model: str | None = None,
    openrouter_model: str = DEFAULT_LLM_MODEL,
    tts_speaker: str,
    tts_dict_id: str | None,
    tts_model: str = DEFAULT_SARVAM_TTS_MODEL,
    mode: InteractionMode = InteractionMode.AUTO,
    session_config: SessionConfig | None = None,
    turn_detector: Any | None = None,
    disable_preemptive_generation: bool = False,
    parallel_tool_calls: bool = True,
) -> AgentSession:
    stt = deepgram.STTv2(
        model=DEFAULT_DEEPGRAM_STT_MODEL,
    )

    web_base = os.getenv("WEB_URL", "http://localhost:3000").rstrip("/")
    resolved_base_url = base_url or os.getenv("LLM_BASE_URL", f"{web_base}/api/v1")
    resolved_model = model or (openrouter_model if openrouter_model != DEFAULT_OPENROUTER_MODEL else None) or os.getenv("LLM_MODEL", DEFAULT_LLM_MODEL)
    resolved_api_key = api_key or os.getenv("LLM_API_KEY", "token-pending")

    llm = openai.LLM(
        model=resolved_model,
        base_url=resolved_base_url,
        api_key=resolved_api_key,
        parallel_tool_calls=parallel_tool_calls,
    )

    effective_session_config = session_config or SessionConfig()
    tts = build_tts(
        tts_speaker=tts_speaker,
        tts_dict_id=tts_dict_id,
        tts_model=tts_model,
        session_config=effective_session_config,
    )

    if mode is InteractionMode.PTT:
        return AgentSession(
            stt=stt,
            llm=llm,
            tts=tts,
            turn_handling=TurnHandlingOptions(
                turn_detection="manual",
                interruption={
                    "min_duration": 0.5,
                    "resume_false_interruption": True,
                },
            ),
            use_tts_aligned_transcript=True,
            preemptive_generation=False,
        )

    preemptive_generation: PreemptiveGenerationOptions = (
        {"enabled": False}
        if disable_preemptive_generation
        else {}
    )

    return AgentSession(
        stt=stt,
        llm=llm,
        tts=tts,
        max_tool_steps=5,
        turn_handling=TurnHandlingOptions(
            turn_detection=turn_detector or TurnDetector(version="v1"),
            endpointing={
                "mode": "dynamic",
                "min_delay": 0.5,
                "max_delay": 1.5,
            },
            interruption={
                "min_duration": 0.5,
                "resume_false_interruption": True,
            },
            preemptive_generation=preemptive_generation,
            user_turn_limit={
                "max_duration": 60.0,
            },
        ),
    )
