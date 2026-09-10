"""Recording storage operations for S3 uploads."""

from __future__ import annotations

import json
import logging
from typing import Any

import boto3
from botocore.config import Config

from domains.recording.storage.url_builder import build_s3_url
from domains.recording.config import RecordingConfig

logger = logging.getLogger(__name__)

_s3_client = None
_s3_client_key: tuple[str, ...] | None = None


def _get_s3_client(config: RecordingConfig):
    global _s3_client, _s3_client_key
    client_key = (
        config.s3_access_key,
        config.s3_secret_key,
        config.s3_region,
        config.s3_endpoint,
        str(config.s3_force_path_style),
    )
    if _s3_client is not None and _s3_client_key == client_key:
        return _s3_client

    kwargs: dict = {
        "region_name": config.s3_region,
        "config": Config(
            connect_timeout=5,
            read_timeout=config.s3_upload_timeout_seconds,
            retries={"max_attempts": 2, "mode": "standard"},
            s3={"addressing_style": ("path" if config.s3_force_path_style else "auto")},
        ),
    }
    if config.s3_access_key and config.s3_secret_key:
        kwargs["aws_access_key_id"] = config.s3_access_key
        kwargs["aws_secret_access_key"] = config.s3_secret_key
    if config.s3_endpoint:
        kwargs["endpoint_url"] = config.s3_endpoint

    _s3_client = boto3.client("s3", **kwargs)
    _s3_client_key = client_key
    return _s3_client


def upload_transcript_json(
    config: RecordingConfig,
    s3_key: str,
    transcript_data: dict,
) -> str:
    client = _get_s3_client(config)
    body = json.dumps(transcript_data, indent=2, default=str)
    client.put_object(
        Bucket=config.s3_bucket,
        Key=s3_key,
        Body=body.encode("utf-8"),
        ContentType="application/json",
    )
    url = build_s3_url(config.s3_bucket, s3_key, config.s3_region, config.s3_endpoint)
    logger.info(f"Uploaded transcript to s3://{config.s3_bucket}/{s3_key}")
    return url


def upload_metrics_json(
    config: RecordingConfig,
    s3_key: str,
    metrics_data: dict,
) -> str:
    client = _get_s3_client(config)
    body = json.dumps(metrics_data, indent=2, default=str)
    client.put_object(
        Bucket=config.s3_bucket,
        Key=s3_key,
        Body=body.encode("utf-8"),
        ContentType="application/json",
    )
    url = build_s3_url(config.s3_bucket, s3_key, config.s3_region, config.s3_endpoint)
    logger.info(f"Uploaded metrics to s3://{config.s3_bucket}/{s3_key}")
    return url


def upload_verbose_json(
    config: RecordingConfig,
    s3_key: str,
    verbose_data: dict,
) -> str:
    client = _get_s3_client(config)
    body = json.dumps(verbose_data, indent=2, default=str)
    client.put_object(
        Bucket=config.s3_bucket,
        Key=s3_key,
        Body=body.encode("utf-8"),
        ContentType="application/json",
    )
    url = build_s3_url(config.s3_bucket, s3_key, config.s3_region, config.s3_endpoint)
    logger.info(f"Uploaded verbose report to s3://{config.s3_bucket}/{s3_key}")
    return url


def upload_json(
    config: RecordingConfig,
    s3_key: str,
    data: dict,
) -> str:
    client = _get_s3_client(config)
    client.put_object(
        Bucket=config.s3_bucket,
        Key=s3_key,
        Body=json.dumps(data, indent=2, default=str).encode("utf-8"),
        ContentType="application/json",
    )
    return build_s3_url(
        config.s3_bucket,
        s3_key,
        config.s3_region,
        config.s3_endpoint,
    )


def upload_png(
    config: RecordingConfig,
    s3_key: str,
    image_bytes: bytes,
) -> str:
    client = _get_s3_client(config)
    client.put_object(
        Bucket=config.s3_bucket,
        Key=s3_key,
        Body=image_bytes,
        ContentType="image/png",
    )
    return build_s3_url(
        config.s3_bucket,
        s3_key,
        config.s3_region,
        config.s3_endpoint,
    )
