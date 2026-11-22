"""AgentSession builder with Deepgram STT, Web LLM, VoxCPM2 TTS, and Hybrid Turn Detection."""

from __future__ import annotations

import logging
import os
from typing import Any

from livekit.agents import (
    APIConnectOptions,
    AgentSession,
    TurnHandlingOptions,
)
from livekit.agents.inference import TurnDetector
from livekit.agents.voice.agent_session import SessionConnectOptions
from livekit.plugins import deepgram, openai
from tts import build_tts

logger = logging.getLogger(__name__)

# "trainertwin-runtime" is the model name the chat bridge accepts (as "trainertwin-brain")
# as "use the agent's own default model".
DEFAULT_LLM_MODEL = "trainertwin-runtime"
# The chat service (eve, chat/agent/channels/openai-compat.ts) runs every session; the web's own runtime is gone.
DEFAULT_LLM_BASE_URL = "http://localhost:2000/v1"
DEFAULT_DEEPGRAM_STT_MODEL = "flux-general-en"


def build_agent_session(
    *,
    base_url: str | None = None,
    api_key: str | None = None,
    model: str | None = None,
    voice: str = "",
    turn_detector: Any | None = None,
    extra_headers: dict[str, str] | None = None,
) -> AgentSession:
    dg_api_key = os.getenv("DEEPGRAM_API_KEY", "").strip() or "test-key"
    stt = deepgram.STTv2(model=DEFAULT_DEEPGRAM_STT_MODEL, api_key=dg_api_key)

    resolved_base_url = base_url or os.getenv("LLM_BASE_URL", DEFAULT_LLM_BASE_URL)
    resolved_model = model or os.getenv("LLM_MODEL", "").strip() or DEFAULT_LLM_MODEL
    resolved_api_key = api_key or ""
    if not resolved_api_key:
        raise ValueError("api_key (per-session runtime token) is required — refusing unauthenticated LLM calls")

    llm = openai.LLM(
        model=resolved_model,
        base_url=resolved_base_url,
        api_key=resolved_api_key,
        extra_headers=extra_headers,
    )

    tts = build_tts(voice=voice)

    return AgentSession(
        stt=stt,
        llm=llm,
        tts=tts,
        max_tool_steps=5,
        user_away_timeout=60.0,
        # The Eve bridge buffers until the durable turn starts streaming; the session's
        # default llm_conn_options timeout (10s) kills every turn whose TTFT exceeds it
        # (measured 4.5-8s with reasoning enabled, plus retry overhead).
        # ponytail: generous LLM timeout; revisit when the bridge streams TTFT-first.
        conn_options=SessionConnectOptions(
            llm_conn_options=APIConnectOptions(max_retry=3, timeout=60.0),
        ),
        turn_handling=TurnHandlingOptions(
            turn_detection=turn_detector or TurnDetector(version="v1-mini"),
            endpointing={
                "mode": "dynamic",
                "min_delay": 0.6,
                # Was 2.0: the detector hit the max on most turns (6 of 7 on Oct 15), ~38% of the wait.
                "max_delay": 1.2,
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
