"""Application-wide tool execution logging with bounded argument redaction."""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Mapping, Sequence
from typing import Any

from livekit.agents import AgentSession, FunctionToolsExecutedEvent

logger = logging.getLogger("intervoo_agent")

MAX_ARGUMENT_DEPTH = 8
MAX_COLLECTION_ITEMS = 100
MAX_STRING_CHARACTERS = 2_000

_SENSITIVE_KEY_PARTS = frozenset(
    {
        "api_key",
        "authorization",
        "code",
        "content",
        "credential",
        "document",
        "email",
        "file",
        "hash",
        "input",
        "markdown",
        "output",
        "password",
        "phone",
        "prompt",
        "question",
        "request",
        "response",
        "resume",
        "secret",
        "storage",
        "text",
        "token",
        "transcript",
        "transition",
        "url",
        "user_name",
    }
)
_SENSITIVE_VALUE_PATTERNS = (
    re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/-]+=*"),
    re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"),
    re.compile(r"(?i)\bhttps?://\S+"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b"),
)


def _is_sensitive_key(key: object) -> bool:
    normalized = str(key).strip().lower().replace("-", "_")
    return any(part in normalized for part in _SENSITIVE_KEY_PARTS)


def _sanitize_string(value: str) -> str:
    if any(pattern.search(value) for pattern in _SENSITIVE_VALUE_PATTERNS):
        return "<redacted>"
    if len(value) <= MAX_STRING_CHARACTERS:
        return value
    omitted = len(value) - MAX_STRING_CHARACTERS
    return f"{value[:MAX_STRING_CHARACTERS]}...<truncated {omitted} chars>"


def _sanitize_value(value: object, *, depth: int = 0) -> object:
    if depth >= MAX_ARGUMENT_DEPTH:
        return "<max-depth>"
    if value is None or isinstance(value, bool | int | float):
        return value
    if isinstance(value, str):
        return _sanitize_string(value)
    if isinstance(value, Mapping):
        sanitized: dict[str, object] = {}
        for index, (key, item) in enumerate(value.items()):
            if index >= MAX_COLLECTION_ITEMS:
                sanitized["<truncated>"] = len(value) - MAX_COLLECTION_ITEMS
                break
            normalized_key = str(key)
            sanitized[normalized_key] = (
                "<redacted>"
                if _is_sensitive_key(normalized_key)
                else _sanitize_value(item, depth=depth + 1)
            )
        return sanitized
    if isinstance(value, Sequence) and not isinstance(value, bytes | bytearray):
        items = [
            _sanitize_value(item, depth=depth + 1)
            for item in value[:MAX_COLLECTION_ITEMS]
        ]
        if len(value) > MAX_COLLECTION_ITEMS:
            items.append(f"<truncated {len(value) - MAX_COLLECTION_ITEMS} items>")
        return items
    return f"<{type(value).__name__}>"


def serialize_tool_arguments(arguments: object) -> str:
    """Return stable JSON for tool arguments without logging sensitive content."""

    parsed = arguments
    if isinstance(arguments, str):
        try:
            parsed = json.loads(arguments)
        except json.JSONDecodeError:
            return json.dumps(
                f"<unparseable arguments: {len(arguments)} chars>",
                separators=(",", ":"),
            )
    sanitized = _sanitize_value(parsed)
    return json.dumps(sanitized, ensure_ascii=True, separators=(",", ":"))


def attach_tool_call_logging(session: AgentSession[Any]) -> None:
    """Log every completed LiveKit function tool through one shared listener."""

    @session.on("function_tools_executed")
    def _on_tools_executed(ev: FunctionToolsExecutedEvent) -> None:
        for function_call, output in ev.zipped():
            logger.info(
                "Tool call executed: name=%s arguments=%s call_id=%s is_error=%s",
                function_call.name,
                serialize_tool_arguments(function_call.arguments),
                function_call.call_id,
                output.is_error if output is not None else None,
            )
