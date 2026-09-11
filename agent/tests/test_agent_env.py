from __future__ import annotations

import pytest

import agent


def test_validate_environment_exits_with_missing_vars(monkeypatch, capsys):
    for key in agent.REQUIRED_ENV_VARS:
        monkeypatch.delenv(key, raising=False)
    monkeypatch.delenv("AWS_S3_BUCKET", raising=False)
    monkeypatch.delenv("S3_BUCKET", raising=False)

    with pytest.raises(SystemExit) as exc:
        agent.validate_environment()

    assert exc.value.code == 1
    err = capsys.readouterr().err
    assert "LIVEKIT_URL" in err and "SARVAM_API_KEY" in err
    assert "AWS_S3_BUCKET/S3_BUCKET" in err


def test_validate_environment_passes_with_all_vars(monkeypatch):
    for key in agent.REQUIRED_ENV_VARS:
        monkeypatch.setenv(key, "x")
    monkeypatch.setenv("AWS_S3_BUCKET", "bucket")
    agent.validate_environment()  # must not raise SystemExit
