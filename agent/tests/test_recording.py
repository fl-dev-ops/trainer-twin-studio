import asyncio

from recording.egress import build_s3_key
from recording import webhook


def test_recording_key_is_scoped_by_immutable_org_id(monkeypatch):
    monkeypatch.setenv("S3_BASE_PREFIX", "trainertwin-dev/")
    key = build_s3_key("org-id", "session-123", "audio.mp4")
    assert key.startswith("trainertwin-dev/org-id/recordings/session-123_")
    assert key.endswith("/audio.mp4")


class _Response:
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


def test_completion_webhook_carries_the_service_secret(monkeypatch):
    sent = []
    monkeypatch.setenv("COPILOT_SERVICE_SECRET", "s3cret")
    monkeypatch.setattr(webhook.request, "urlopen", lambda req, **_: sent.append(req) or _Response())
    asyncio.run(webhook.post_completion_webhook("https://web.test/api/sessions/webhook", {"session_id": "s1"}))
    assert len(sent) == 1
    assert sent[0].get_header("Authorization") == "Bearer s3cret"


def test_completion_webhook_is_not_sent_without_the_secret(monkeypatch):
    sent = []
    monkeypatch.delenv("COPILOT_SERVICE_SECRET", raising=False)
    monkeypatch.setattr(webhook.request, "urlopen", lambda req, **_: sent.append(req) or _Response())
    asyncio.run(webhook.post_completion_webhook("https://web.test/api/sessions/webhook", {"session_id": "s1"}))
    assert sent == []
