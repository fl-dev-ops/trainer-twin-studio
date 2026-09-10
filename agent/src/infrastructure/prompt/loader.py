"""Prompt loading from URLs and file paths."""

from __future__ import annotations

import logging
from pathlib import Path
from urllib import error, request
from urllib.parse import urlparse

from infrastructure.prompt.cache import cache_prompt, get_cached_prompt

logger = logging.getLogger(__name__)

DEFAULT_PROMPT_FETCH_TIMEOUT_SECONDS = 10
AGENT_ROOT = Path(__file__).resolve().parents[3]


def load_prompt(
    url: str, *, timeout: float = DEFAULT_PROMPT_FETCH_TIMEOUT_SECONDS
) -> str:
    if not isinstance(url, str) or not url.strip():
        raise ValueError("prompt_url must be a non-empty string")

    prompt_source = url.strip()
    cached = get_cached_prompt(prompt_source)
    if cached is not None:
        return cached

    parsed = urlparse(prompt_source)
    if parsed.scheme in {"http", "https"}:
        logger.info(f"Fetching prompt from {prompt_source}")
        try:
            with request.urlopen(prompt_source, timeout=timeout) as response:
                status = getattr(response, "status", response.getcode())
                if status >= 400:
                    raise RuntimeError(f"Prompt fetch returned HTTP {status}")
                body = response.read().decode("utf-8")
        except error.HTTPError as e:
            raise RuntimeError(
                f"Prompt fetch failed for {prompt_source}: HTTP {e.code} {e.reason}"
            ) from e
        except Exception as e:
            raise RuntimeError(f"Prompt fetch failed for {prompt_source}: {e}") from e
    else:
        prompt_path = Path(prompt_source)
        if not prompt_path.is_absolute():
            prompt_path = AGENT_ROOT / prompt_path
        logger.info(f"Loading prompt from {prompt_path}")
        try:
            body = prompt_path.read_text(encoding="utf-8")
        except Exception as e:
            raise RuntimeError(f"Prompt load failed for {prompt_source}: {e}") from e

    text = body.strip()
    if not text:
        raise ValueError(f"Prompt is empty: {prompt_source}")

    cache_prompt(prompt_source, text)
    return text


def extract_prompt_version(prompt_url: str) -> str:
    """'prompts/diagnostic/v5.md' -> 'v5'"""
    return Path(prompt_url).stem or "unknown"
