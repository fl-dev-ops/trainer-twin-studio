"""Question types and normalization."""

from __future__ import annotations

from typing import Any

SUPPORTED_CODE_LANGUAGES = {"java", "javascript", "python", "react"}


def normalize_question(record: object) -> dict[str, Any] | None:
    """Normalize a question record from the interview plan.

    Args:
        record: Raw question record from the interview plan.

    Returns:
        Normalized question dict or None if invalid.
    """
    if not isinstance(record, dict):
        return None
    question_id = record.get("id")
    text = record.get("text")
    if not isinstance(question_id, str) or not question_id.strip():
        return None
    if not isinstance(text, str) or not text.strip():
        return None

    surface_raw = record.get("surface")
    surface = surface_raw.strip().lower() if isinstance(surface_raw, str) else "verbal"
    if surface not in {"verbal", "code", "whiteboard"}:
        surface = "verbal"

    answer_mode_raw = record.get("answerMode")
    answer_mode = (
        answer_mode_raw.strip().lower()
        if isinstance(answer_mode_raw, str)
        else ("verbal" if surface == "verbal" else "surface")
    )
    if answer_mode not in {"verbal", "surface"}:
        answer_mode = "verbal" if surface == "verbal" else "surface"

    language_raw = record.get("language")
    language = (
        language_raw.strip().lower()
        if isinstance(language_raw, str)
        and language_raw.strip().lower() in SUPPORTED_CODE_LANGUAGES
        else "javascript"
    )
    return {
        "id": question_id.strip(),
        "text": text.strip(),
        "surface": surface,
        "answerMode": answer_mode,
        "language": language,
    }


def message_turn(item: object) -> dict[str, str] | None:
    """Extract a message turn from a chat item.

    Args:
        item: Chat item from the conversation.

    Returns:
        Dict with role and text, or None if not a valid turn.
    """
    from livekit.agents import llm

    if not isinstance(item, llm.ChatMessage):
        return None
    if item.extra.get("internal_timer") is True:
        return None
    if item.role not in {"assistant", "user"}:
        return None
    text = item.text_content
    if not isinstance(text, str) or not text.strip():
        return None
    return {"role": item.role, "text": text.strip()}
