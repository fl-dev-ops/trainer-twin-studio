"""Recording and session persistence domain."""

from domains.recording.egress.manager import (
    TERMINAL_STATUSES,
    start_recording,
)
from domains.recording.storage.store import (
    upload_metrics_json,
    upload_transcript_json,
    upload_verbose_json,
)
from domains.recording.storage.url_builder import (
    build_audio_s3_key,
    build_metrics_s3_key,
    build_s3_url,
    build_transcript_s3_key,
    build_verbose_s3_key,
    build_video_s3_key,
)

__all__ = [
    "TERMINAL_STATUSES",
    "build_audio_s3_key",
    "build_metrics_s3_key",
    "build_s3_url",
    "build_transcript_s3_key",
    "build_verbose_s3_key",
    "build_video_s3_key",
    "start_recording",
    "upload_metrics_json",
    "upload_transcript_json",
    "upload_verbose_json",
]
