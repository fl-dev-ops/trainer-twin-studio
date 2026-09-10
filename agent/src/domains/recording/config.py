"""Recording configuration."""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class RecordingConfig:
    database_url: str = ""
    s3_egress_enabled: bool = True
    s3_bucket: str = ""
    s3_region: str = "us-east-1"
    s3_endpoint: str = ""
    s3_access_key: str = ""
    s3_secret_key: str = ""
    s3_force_path_style: bool = False
    s3_base_prefix: str = "agents"
    webhook_url: str = ""
    egress_start_timeout_seconds: int = 15
    egress_poll_timeout_seconds: int = 45
    s3_upload_timeout_seconds: int = 15

    @property
    def enabled(self) -> bool:
        return bool(self.s3_egress_enabled and self.s3_bucket)


def build_recording_config(env: dict[str, str] | None = None) -> RecordingConfig:
    values = os.environ if env is None else env

    def positive_int(name: str, default: int) -> int:
        try:
            parsed = int(values.get(name, str(default)))
        except (TypeError, ValueError):
            return default
        return parsed if parsed > 0 else default

    return RecordingConfig(
        database_url=values.get("DATABASE_URL", ""),
        s3_egress_enabled=values.get("ENABLE_RECORDING", "true").lower()
        in ("1", "true", "yes"),
        s3_bucket=values.get("AWS_S3_BUCKET", ""),
        s3_region=values.get("AWS_REGION")
        or values.get("AWS_DEFAULT_REGION", "us-east-1"),
        s3_endpoint=values.get("AWS_S3_ENDPOINT", ""),
        s3_access_key=values.get("AWS_ACCESS_KEY_ID", ""),
        s3_secret_key=values.get("AWS_SECRET_ACCESS_KEY", ""),
        s3_force_path_style=values.get("AWS_S3_FORCE_PATH_STYLE", "").lower()
        in ("1", "true", "yes"),
        s3_base_prefix=values.get("S3_BASE_PREFIX", "agents"),
        webhook_url=values.get("WEBHOOK_URL", ""),
        egress_start_timeout_seconds=positive_int("EGRESS_START_TIMEOUT_SECONDS", 15),
        egress_poll_timeout_seconds=positive_int("EGRESS_POLL_TIMEOUT_SECONDS", 45),
        s3_upload_timeout_seconds=positive_int("S3_UPLOAD_TIMEOUT_SECONDS", 15),
    )
