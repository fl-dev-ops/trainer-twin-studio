from __future__ import annotations

import logging
import re
import secrets
import string

logger = logging.getLogger(__name__)


def generate_demo_user_id() -> str:
    alphabet = string.ascii_lowercase + string.digits
    suffix = "".join(secrets.choice(alphabet) for _ in range(7))
    return f"demo_{suffix}"


def resolve_user_id_from_room_metadata(room_metadata: str | None) -> str:
    import json

    if room_metadata:
        try:
            payload = json.loads(room_metadata)
            if isinstance(payload, dict):
                user_id = payload.get("user_id")
                if isinstance(user_id, str) and user_id.strip():
                    return user_id.strip()
        except json.JSONDecodeError:
            logger.warning("Room metadata is not valid JSON, generating demo user_id")
    return generate_demo_user_id()


def _extract_phone(value: str) -> str | None:
    text = value.strip()
    if not text:
        return None
    if text.startswith("user_+"):
        return text.removeprefix("user_")
    if text.startswith("sip_+"):
        return text.removeprefix("sip_")
    match = re.search(r"\+\d{8,15}", text)
    if match:
        return match.group(0)
    return None


def _normalize_user_id(raw: str) -> str | None:
    text = raw.strip()
    if not text:
        return None
    if text.startswith("user_+"):
        return text
    phone = _extract_phone(text)
    if phone:
        return f"user_{phone}"
    return None


def resolve_user_id_from_call_context(
    *,
    current_user_id: str,
    participant_identity: str | None,
    participant_attributes: dict[str, str] | None,
    room_name: str | None,
) -> str:
    if current_user_id and not current_user_id.startswith("demo_"):
        return current_user_id

    if participant_attributes:
        for key, value in participant_attributes.items():
            if key.lower() == "user_id" and value.strip():
                return value.strip()

    if participant_identity:
        normalized = _normalize_user_id(participant_identity)
        if normalized:
            return normalized

    if participant_attributes:
        for key, value in participant_attributes.items():
            if "phone" in key.lower() or key.lower().startswith("sip"):
                normalized = _normalize_user_id(value)
                if normalized:
                    return normalized

    if room_name:
        normalized = _normalize_user_id(room_name)
        if normalized:
            return normalized

    return current_user_id


def resolve_phone_number_from_call_context(
    *,
    participant_identity: str | None,
    participant_attributes: dict[str, str] | None,
    room_name: str | None,
) -> str | None:
    if participant_identity:
        phone = _extract_phone(participant_identity)
        if phone:
            return phone

    if participant_attributes:
        for key, value in participant_attributes.items():
            if "phone" in key.lower() or key.lower().startswith("sip"):
                phone = _extract_phone(value)
                if phone:
                    return phone

    if room_name:
        return _extract_phone(room_name)

    return None
