"""Avatar provider integration."""

from __future__ import annotations

import logging
import os
from collections.abc import Callable
from typing import Protocol

from livekit import rtc
from livekit.agents import AgentSession
from livekit.plugins import liveavatar, simli

logger = logging.getLogger(__name__)

SIMLI_ROOM_LIFETIME_SECONDS = 1 * 60 * 60


class AvatarConfigurationError(ValueError):
    pass


class AvatarSession(Protocol):
    async def start(self, agent_session: AgentSession, room: rtc.Room) -> None: ...


def _required_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise AvatarConfigurationError(f"{name} is required")
    return value


def _build_liveavatar() -> AvatarSession:
    return liveavatar.AvatarSession(
        api_key=_required_env("LIVEAVATAR_API_KEY"),
        avatar_id=_required_env("LIVEAVATAR_AVATAR_ID"),
    )


def _build_simli() -> AvatarSession:
    api_key = _required_env("SIMLI_API_KEY")
    face_id = _required_env("SIMLI_FACE_ID")
    emotion_id = os.getenv("SIMLI_EMOTION_ID")
    config = (
        simli.SimliConfig(
            api_key=api_key,
            face_id=face_id,
            emotion_id=emotion_id,
            max_session_length=SIMLI_ROOM_LIFETIME_SECONDS,
            max_idle_time=SIMLI_ROOM_LIFETIME_SECONDS,
        )
        if emotion_id
        else simli.SimliConfig(
            api_key=api_key,
            face_id=face_id,
            max_session_length=SIMLI_ROOM_LIFETIME_SECONDS,
            max_idle_time=SIMLI_ROOM_LIFETIME_SECONDS,
        )
    )
    return simli.AvatarSession(simli_config=config)


ProviderFactory = Callable[[], AvatarSession]

PROVIDER_FACTORIES: dict[str, ProviderFactory] = {
    "liveavatar": _build_liveavatar,
    "simli": _build_simli,
}

DISABLED_PROVIDERS = {
    "hedra": (
        "Hedra sunset its Realtime Avatar service on April 15, 2026; "
        "the LiveKit Hedra plugin no longer functions"
    ),
}


def create_avatar_session(
    provider_name: str | None = None,
) -> tuple[str, AvatarSession] | None:
    provider = (
        provider_name if provider_name is not None else os.getenv("AVATAR_PROVIDER", "")
    ).strip().lower()

    if provider in {"", "none", "off", "disabled"}:
        return None
    if provider in DISABLED_PROVIDERS:
        raise AvatarConfigurationError(DISABLED_PROVIDERS[provider])

    factory = PROVIDER_FACTORIES.get(provider)
    if factory is None:
        supported = ", ".join(sorted(PROVIDER_FACTORIES))
        raise AvatarConfigurationError(
            f"Unsupported AVATAR_PROVIDER={provider!r}; supported providers: {supported}"
        )
    return provider, factory()


async def start_avatar(
    session: AgentSession,
    room: rtc.Room,
    *,
    enabled: bool,
) -> bool:
    if not enabled:
        return False

    try:
        configured_avatar = create_avatar_session()
    except AvatarConfigurationError as error:
        logger.warning("Avatar unavailable: %s; using audio-only agent", error)
        return False

    if configured_avatar is None:
        logger.info(
            "Avatar requested but AVATAR_PROVIDER is disabled; using audio-only agent"
        )
        return False

    provider, avatar = configured_avatar
    try:
        await avatar.start(session, room)
    except Exception:
        logger.exception(
            "Avatar provider %s failed to start; using audio-only agent",
            provider,
        )
        return False

    logger.info("Avatar provider %s started for room=%s", provider, room.name)
    return True
