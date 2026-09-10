"""Narrow S3 JSON-object reads independent of recording enablement."""

from __future__ import annotations

import json
import logging
import os
import time
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

import boto3
from botocore.config import Config

logger = logging.getLogger(__name__)

S3_RESUME_LOG_PREFIX = "[EXT-API:s3-resume]"


class S3JsonReadError(RuntimeError):
    """Raised when a bounded S3 JSON-object read fails."""


@dataclass(frozen=True)
class S3JsonReadConfig:
    bucket: str
    region: str = "us-east-1"
    endpoint: str = ""
    access_key: str = ""
    secret_key: str = ""
    force_path_style: bool = False
    timeout_seconds: int = 15


def build_s3_json_read_config(
    env: Mapping[str, str] | None = None,
) -> S3JsonReadConfig:
    """Use existing AWS names without depending on `ENABLE_RECORDING`."""

    values = os.environ if env is None else env
    return S3JsonReadConfig(
        bucket=values.get("AWS_S3_BUCKET", ""),
        region=values.get("AWS_REGION")
        or values.get("AWS_DEFAULT_REGION", "us-east-1"),
        endpoint=values.get("AWS_S3_ENDPOINT", ""),
        access_key=values.get("AWS_ACCESS_KEY_ID", ""),
        secret_key=values.get("AWS_SECRET_ACCESS_KEY", ""),
        force_path_style=values.get("AWS_S3_FORCE_PATH_STYLE", "").lower()
        in ("1", "true", "yes"),
    )


def _build_s3_client(config: S3JsonReadConfig):
    kwargs: dict[str, Any] = {
        "region_name": config.region,
        "config": Config(
            connect_timeout=5,
            read_timeout=config.timeout_seconds,
            retries={"max_attempts": 2, "mode": "standard"},
            s3={
                "addressing_style": "path" if config.force_path_style else "auto"
            },
        ),
    }
    if config.access_key and config.secret_key:
        kwargs["aws_access_key_id"] = config.access_key
        kwargs["aws_secret_access_key"] = config.secret_key
    if config.endpoint:
        kwargs["endpoint_url"] = config.endpoint
    return boto3.client("s3", **kwargs)


def read_s3_json_object(
    config: S3JsonReadConfig,
    key: str,
    *,
    max_bytes: int,
) -> Mapping[str, Any]:
    """Read one bounded JSON object; never logs its URL or content."""

    if not config.bucket:
        raise S3JsonReadError("AWS_S3_BUCKET is required")
    if not isinstance(key, str) or not key:
        raise S3JsonReadError("S3 key is required")
    if isinstance(max_bytes, bool) or not isinstance(max_bytes, int) or max_bytes <= 0:
        raise S3JsonReadError("max_bytes must be a positive integer")

    started = time.monotonic()
    logger.info(
        "%s action=read status=started elapsed_ms=0",
        S3_RESUME_LOG_PREFIX,
    )
    body = None
    try:
        response = _build_s3_client(config).get_object(Bucket=config.bucket, Key=key)
        content_length = response.get("ContentLength")
        if isinstance(content_length, int) and content_length > max_bytes:
            raise S3JsonReadError("S3 JSON object exceeds configured byte limit")
        body = response["Body"]
        payload = body.read(max_bytes + 1)
        if len(payload) > max_bytes:
            raise S3JsonReadError("S3 JSON object exceeds configured byte limit")
        value = json.loads(payload)
        if not isinstance(value, dict) or not all(
            isinstance(item, str) for item in value
        ):
            raise S3JsonReadError("S3 JSON object must contain an object")
    except Exception as error:
        logger.error(
            "%s action=read status=failed elapsed_ms=%d error_type=%s",
            S3_RESUME_LOG_PREFIX,
            int((time.monotonic() - started) * 1000),
            type(error).__name__,
        )
        if isinstance(error, S3JsonReadError):
            raise
        raise S3JsonReadError("S3 JSON object read failed") from error
    finally:
        if body is not None:
            body.close()

    logger.info(
        "%s action=read status=completed elapsed_ms=%d",
        S3_RESUME_LOG_PREFIX,
        int((time.monotonic() - started) * 1000),
    )
    return value
