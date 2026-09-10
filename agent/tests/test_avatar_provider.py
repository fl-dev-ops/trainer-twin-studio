from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

import services.agent.avatar as avatar_module
from services.agent.avatar import (
    AvatarConfigurationError,
    create_avatar_session,
    start_avatar,
)


def test_create_avatar_session_uses_liveavatar_provider(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, str] = {}

    def fake_avatar_session(**kwargs: str) -> object:
        captured.update(kwargs)
        return object()

    monkeypatch.setenv("AVATAR_PROVIDER", "liveavatar")
    monkeypatch.setenv("LIVEAVATAR_API_KEY", "liveavatar-key")
    monkeypatch.setenv("LIVEAVATAR_AVATAR_ID", "avatar-id")
    monkeypatch.setattr(
        avatar_module.liveavatar,
        "AvatarSession",
        fake_avatar_session,
    )

    provider, _session = create_avatar_session() or (None, None)

    assert provider == "liveavatar"
    assert captured == {
        "api_key": "liveavatar-key",
        "avatar_id": "avatar-id",
    }


def test_create_avatar_session_uses_simli_provider(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    def fake_avatar_session(**kwargs: object) -> object:
        captured.update(kwargs)
        return object()

    monkeypatch.setenv("AVATAR_PROVIDER", "simli")
    monkeypatch.setenv("SIMLI_API_KEY", "simli-key")
    monkeypatch.setenv("SIMLI_FACE_ID", "face-id")
    monkeypatch.setenv("SIMLI_EMOTION_ID", "emotion-id")
    monkeypatch.setattr(
        avatar_module.simli,
        "AvatarSession",
        fake_avatar_session,
    )

    provider, _session = create_avatar_session() or (None, None)
    config = captured["simli_config"]

    assert provider == "simli"
    assert config.api_key == "simli-key"
    assert config.face_id == "face-id"
    assert config.emotion_id == "emotion-id"


def test_hedra_provider_reports_that_the_service_is_disabled() -> None:
    with pytest.raises(AvatarConfigurationError, match="no longer functions"):
        create_avatar_session("hedra")


@pytest.mark.asyncio
async def test_avatar_failure_preserves_audio_only_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    start = AsyncMock(side_effect=RuntimeError("provider unavailable"))
    monkeypatch.setattr(
        avatar_module,
        "create_avatar_session",
        lambda: ("simli", SimpleNamespace(start=start)),
    )

    room = SimpleNamespace(name="mock-room")
    started = await start_avatar(object(), room, enabled=True)

    assert started is False
    start.assert_awaited_once()
