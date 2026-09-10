"""Session metrics collection and logging."""

from __future__ import annotations

import logging

from langfuse import get_client as get_langfuse_client
from livekit.agents import AgentSession, MetricsCollectedEvent, metrics
from livekit.agents.metrics import LLMMetrics, STTMetrics, TTSMetrics

logger = logging.getLogger("intervoo_agent")


def attach_metrics_logging(session: AgentSession, room_name: str):
    stt_audio_total: float = 0.0
    tts_chars_total: int = 0
    tts_audio_total: float = 0.0
    llm_prompt_tokens_total: int = 0
    llm_completion_tokens_total: int = 0

    llm_ttft_samples: list[float] = []
    llm_duration_samples: list[float] = []
    llm_tps_samples: list[float] = []
    tts_ttfb_samples: list[float] = []
    tts_duration_samples: list[float] = []
    stt_duration_samples: list[float] = []

    @session.on("metrics_collected")
    def _on_metrics_collected(ev: MetricsCollectedEvent) -> None:
        nonlocal stt_audio_total, tts_chars_total, tts_audio_total
        nonlocal llm_prompt_tokens_total, llm_completion_tokens_total
        metrics.log_metrics(ev.metrics)

        for m in ev.metrics:
            if isinstance(m, LLMMetrics):
                ttft_ms = round(m.ttft * 1000, 1)
                dur_ms = round(m.duration * 1000, 1)
                llm_ttft_samples.append(ttft_ms)
                llm_duration_samples.append(dur_ms)
                if m.tokens_per_second > 0:
                    llm_tps_samples.append(round(m.tokens_per_second, 1))
                llm_prompt_tokens_total += m.prompt_tokens
                llm_completion_tokens_total += m.completion_tokens
                logger.info(
                    "llm_latency room=%s ttft_ms=%.1f duration_ms=%.1f "
                    "tokens_per_second=%.1f prompt_tokens=%d completion_tokens=%d",
                    room_name, ttft_ms, dur_ms,
                    m.tokens_per_second, m.prompt_tokens, m.completion_tokens,
                )

            elif isinstance(m, TTSMetrics):
                ttfb_ms = round(m.ttfb * 1000, 1)
                dur_ms = round(m.duration * 1000, 1)
                tts_ttfb_samples.append(ttfb_ms)
                tts_duration_samples.append(dur_ms)
                tts_chars_total += m.characters_count
                tts_audio_total += m.audio_duration
                logger.info(
                    "tts_latency room=%s ttfb_ms=%.1f duration_ms=%.1f "
                    "audio_duration_s=%.2f characters=%d",
                    room_name, ttfb_ms, dur_ms, m.audio_duration, m.characters_count,
                )

            elif isinstance(m, STTMetrics):
                stt_audio_total += m.audio_duration
                if m.duration > 0:
                    dur_ms = round(m.duration * 1000, 1)
                    stt_duration_samples.append(dur_ms)
                    logger.info(
                        "stt_latency room=%s duration_ms=%.1f audio_duration_s=%.2f",
                        room_name, dur_ms, m.audio_duration,
                    )

    def _avg(samples: list[float]) -> float | None:
        return round(sum(samples) / len(samples), 1) if samples else None

    def log_usage_summary() -> None:
        avg_llm_ttft = _avg(llm_ttft_samples)
        avg_llm_dur = _avg(llm_duration_samples)
        avg_llm_tps = _avg(llm_tps_samples)
        avg_tts_ttfb = _avg(tts_ttfb_samples)
        avg_tts_dur = _avg(tts_duration_samples)
        avg_stt_dur = _avg(stt_duration_samples)

        logger.info(
            "session_summary room=%s "
            "stt_audio_s=%.2f "
            "tts_chars=%d tts_audio_s=%.2f "
            "prompt_tokens=%d completion_tokens=%d llm_turns=%d "
            "avg_llm_ttft_ms=%s avg_llm_dur_ms=%s avg_llm_tps=%s "
            "avg_tts_ttfb_ms=%s avg_tts_dur_ms=%s",
            room_name,
            stt_audio_total,
            tts_chars_total, tts_audio_total,
            llm_prompt_tokens_total, llm_completion_tokens_total, len(llm_ttft_samples),
            avg_llm_ttft, avg_llm_dur, avg_llm_tps,
            avg_tts_ttfb, avg_tts_dur,
        )
        try:
            lf = get_langfuse_client()
            scores: list[tuple[str, float]] = [
                ("stt_audio_seconds", stt_audio_total),
                ("tts_characters", float(tts_chars_total)),
                ("tts_audio_seconds", tts_audio_total),
                ("total_prompt_tokens", float(llm_prompt_tokens_total)),
                ("total_completion_tokens", float(llm_completion_tokens_total)),
                ("total_llm_turns", float(len(llm_ttft_samples))),
            ]
            if avg_llm_ttft is not None:
                scores += [
                    ("avg_llm_ttft_ms", avg_llm_ttft),
                    ("avg_llm_duration_ms", avg_llm_dur),
                ]
            if avg_llm_tps is not None:
                scores.append(("avg_llm_tokens_per_second", avg_llm_tps))
            if avg_tts_ttfb is not None:
                scores += [
                    ("avg_tts_ttfb_ms", avg_tts_ttfb),
                    ("avg_tts_duration_ms", avg_tts_dur),
                ]
            if avg_stt_dur is not None:
                scores.append(("avg_stt_duration_ms", avg_stt_dur))
            for name, value in scores:
                lf.create_score(trace_id=room_name, name=name, value=value, data_type="NUMERIC")
        except Exception as e:
            logger.warning("Failed to log usage scores to Langfuse: %s", e)

    return log_usage_summary
