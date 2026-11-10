"""Langfuse tracing for the LiveKit agent.

Canonical integration (raw OTLP/HTTP — zero extra dependencies, livekit-agents
already ships opentelemetry-sdk + the OTLP HTTP exporter):
  https://langfuse.com/integrations/frameworks/livekit
  https://docs.livekit.io/testing/observability/tracing/

Capture: every livekit-agents span (session, STT/LLM/TTS nodes, tool calls,
turn boundaries, chat context, transcripts, token/latency attributes) is
exported. Spans are stamped with `session.id` (one Langfuse session per room)
and `user.id` plus org/session ids from room metadata.
"""

from __future__ import annotations

import base64
import json
import logging
import os
from typing import Any

from livekit.agents import get_job_context
from livekit.agents.telemetry import set_tracer_provider
from opentelemetry.context import Context
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import SERVICE_NAME, Resource
from opentelemetry.sdk.trace import Span, SpanProcessor, TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.util.types import AttributeValue

logger = logging.getLogger("trainertwin_agent")

_provider: TracerProvider | None = None


def session_attributes() -> dict[str, AttributeValue]:
    """Grouping attributes for the current job: Langfuse session/user ids and
    room metadata corners (sessionId, orgId, userId) kept as span attributes."""
    ctx = get_job_context(required=False)
    if ctx is None:
        return {}
    attrs: dict[str, AttributeValue] = {"session.id": str(ctx.room.name)}
    try:
        raw = ctx.room.metadata or ctx.job.metadata
        meta: dict[str, Any] = json.loads(raw) if raw else {}
        if not isinstance(meta, dict):
            meta = {}
    except Exception:
        meta = {}
    for key, target in (
        ("userId", "user.id"),
        ("orgId", "trainer.org.id"),
        ("sessionId", "trainer.session_id"),
    ):
        value = str(meta.get(key) or "").strip()
        if value:
            attrs[target] = value
    return attrs


class _SessionAttributesProcessor(SpanProcessor):
    def on_start(self, span: Span, parent_context: Context | None = None) -> None:
        attrs = session_attributes()
        tags: list[str] = ["voice-agent"]
        env = os.getenv("LANGFUSE_ENVIRONMENT")
        if env:
            tags.append(env)
        if attrs:
            span.set_attributes(attrs)
        if os.getenv("AGENT_NAME"):
            tags.append(os.getenv("AGENT_NAME", ""))  # type: ignore[arg-type]
        if tags:
            span.set_attribute("langfuse.tags", tags)

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        return True


def setup_langfuse() -> TracerProvider | None:
    """Attach the Langfuse-bound tracer provider once, at worker startup.
    Spans flow through set_tracer_provider to LLM/STT/TTS/session turn spans."""
    global _provider
    if _provider is not None:
        return _provider

    base = os.getenv("LANGFUSE_BASE_URL", "").rstrip("/")
    public = os.getenv("LANGFUSE_PUBLIC_KEY", "").strip()
    secret = os.getenv("LANGFUSE_SECRET_KEY", "").strip()
    if not (base and public and secret):
        logger.info("Langfuse tracing disabled: LANGFUSE_* not set")
        return None

    auth = base64.b64encode(f"{public}:{secret}".encode()).decode()
    env = os.getenv("LANGFUSE_ENVIRONMENT", "production")
    _provider = TracerProvider(
        resource=Resource.create(
            {SERVICE_NAME: os.getenv("AGENT_NAME", "intervoo-agent"), "langfuse.environment": env}
        )
    )
    _provider.add_span_processor(_SessionAttributesProcessor())
    _provider.add_span_processor(
        BatchSpanProcessor(
            OTLPSpanExporter(
                endpoint=f"{base}/api/public/otel/v1/traces",
                headers={
                    "Authorization": f"Basic {auth}",
                    "x-langfuse-ingestion-version": "4",
                },
            )
        )
    )
    set_tracer_provider(_provider)
    logger.info("Langfuse tracing enabled -> %s (environment=%s)", base, env)
    return _provider


def force_flush() -> None:
    if _provider is not None:
        _provider.force_flush()
