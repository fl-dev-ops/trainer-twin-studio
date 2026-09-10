"""Prompt caching utilities."""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

_prompt_cache: dict[str, str] = {}


def get_cached_prompt(source: str) -> str | None:
    """Get a cached prompt by source URL or path."""
    return _prompt_cache.get(source)


def cache_prompt(source: str, content: str) -> None:
    """Cache a prompt by source URL or path."""
    _prompt_cache[source] = content


def clear_prompt_cache() -> None:
    """Clear all cached prompts."""
    _prompt_cache.clear()
