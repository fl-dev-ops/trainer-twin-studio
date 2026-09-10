"""S3 URL and key building for recording storage."""

from __future__ import annotations

from datetime import datetime, timezone


def build_s3_key(
    agent_type: str,
    room_name: str,
    filename: str,
    base_prefix: str = "agents",
    now: datetime | None = None,
) -> str:
    ts = now or datetime.now(timezone.utc)
    date_path = ts.strftime("%Y/%m/%d")
    return f"{base_prefix}/{agent_type}/sessions/{date_path}/{room_name}/{filename}"


def build_s3_url(
    bucket: str,
    key: str,
    region: str = "us-east-1",
    endpoint: str = "",
) -> str:
    if endpoint:
        return f"{endpoint.rstrip('/')}/{bucket}/{key}"
    return f"https://{bucket}.s3.{region}.amazonaws.com/{key}"


def build_audio_s3_key(
    agent_type: str,
    room_name: str,
    base_prefix: str = "agents",
    now: datetime | None = None,
) -> str:
    return build_s3_key(agent_type, room_name, "audio.mp3", base_prefix, now)


def build_video_s3_key(
    agent_type: str,
    room_name: str,
    base_prefix: str = "agents",
    now: datetime | None = None,
) -> str:
    return build_s3_key(agent_type, room_name, "video.mp4", base_prefix, now)


def build_transcript_s3_key(
    agent_type: str,
    room_name: str,
    base_prefix: str = "agents",
    now: datetime | None = None,
) -> str:
    return build_s3_key(agent_type, room_name, "transcript.json", base_prefix, now)


def build_metrics_s3_key(
    agent_type: str,
    room_name: str,
    base_prefix: str = "agents",
    now: datetime | None = None,
) -> str:
    return build_s3_key(agent_type, room_name, "metrics.json", base_prefix, now)


def build_verbose_s3_key(
    agent_type: str,
    room_name: str,
    base_prefix: str = "agents",
    now: datetime | None = None,
) -> str:
    return build_s3_key(agent_type, room_name, "verbose.json", base_prefix, now)
