"""Langfuse integration for tracing and observability."""

from __future__ import annotations

import logging
import os

from langfuse import Langfuse, get_client
from livekit.agents.telemetry import set_tracer_provider
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.util.types import AttributeValue

logger = logging.getLogger(__name__)

_provider: TracerProvider | None = None


def setup_langfuse(
    metadata: dict[str, AttributeValue] | None = None,
    *,
    host: str | None = None,
    public_key: str | None = None,
    secret_key: str | None = None,
    strict: bool = False,
) -> TracerProvider | None:
    global _provider

    public_key = public_key or os.getenv("LANGFUSE_PUBLIC_KEY")
    secret_key = secret_key or os.getenv("LANGFUSE_SECRET_KEY")
    host = host or os.getenv("LANGFUSE_HOST") or os.getenv("LANGFUSE_BASE_URL")

    if not public_key or not secret_key or not host:
        msg = (
            "Langfuse disabled: LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, "
            "and LANGFUSE_HOST (or LANGFUSE_BASE_URL) must all be set"
        )
        if strict:
            raise ValueError(msg)
        logger.warning(msg)
        return None

    if _provider is None:
        _provider = TracerProvider()
        Langfuse(
            public_key=public_key,
            secret_key=secret_key,
            base_url=host,
            tracer_provider=_provider,
            should_export_span=lambda span: True,
        )
        logger.info("Langfuse tracer provider initialized")

    set_tracer_provider(_provider, metadata=metadata)
    return _provider


def flush_langfuse() -> None:
    try:
        get_client().flush()
    except Exception as e:
        logger.warning(f"Langfuse flush failed: {e}")
