"""AgentSession builder with Deepgram STT, Web LLM, VoxCPM2 TTS, and Hybrid Turn Detection."""

from __future__ import annotations

import logging
import os
from typing import Any

from livekit.agents import (
    AgentSession,
    TurnHandlingOptions,
)
from livekit.agents.inference import TurnDetector
from livekit.plugins import deepgram, openai
from tts import build_tts

logger = logging.getLogger(__name__)

DEFAULT_LLM_MODEL = "trainertwin-runtime"
DEFAULT_DEEPGRAM_STT_MODEL = "flux-general-en"


def build_agent_session(
    *,
    base_url: str | None = None,
    api_key: str | None = None,
    model: str | None = None,
    voice: str = "",
    turn_detector: Any | None = None,
) -> AgentSession:
    dg_api_key = os.getenv("DEEPGRAM_API_KEY", "").strip() or "test-key"
    stt = deepgram.STTv2(model=DEFAULT_DEEPGRAM_STT_MODEL, api_key=dg_api_key)

    web_base = os.getenv("WEB_URL", "http://localhost:3000").rstrip("/")
    resolved_base_url = base_url or os.getenv("LLM_BASE_URL", f"{web_base}/api/v1")
    resolved_model = model or DEFAULT_LLM_MODEL
    resolved_api_key = api_key or "token-pending"

    llm = openai.LLM(
        model=resolved_model,
        base_url=resolved_base_url,
        api_key=resolved_api_key,
    )

    tts = build_tts(voice=voice)

    return AgentSession(
        stt=stt,
        llm=llm,
        tts=tts,
        max_tool_steps=5,
        turn_handling=TurnHandlingOptions(
            turn_detection=turn_detector or TurnDetector(version="v1-mini"),
            endpointing={
                "mode": "dynamic",
                "min_delay": 0.6,
                "max_delay": 2.0,
            },
            interruption={
                "mode": "adaptive",
                "min_duration": 0.5,
                "min_words": 2,
                "resume_false_interruption": True,
                "false_interruption_timeout": 2.0,
            },
            preemptive_generation={"enabled": False},
            user_turn_limit={
                "max_duration": 90.0,
            },
        ),
    )
