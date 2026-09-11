from recording.egress import build_s3_key


def test_recording_key_is_scoped_by_immutable_org_id(monkeypatch):
    monkeypatch.setenv("S3_BASE_PREFIX", "trainertwin-dev/")
    key = build_s3_key("org-id", "session-123", "audio.mp4")
    assert key.startswith("trainertwin-dev/org-id/recordings/session-123_")
    assert key.endswith("/audio.mp4")
