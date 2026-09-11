"""LiveKit Room Composite Egress management (S3 audio and video)."""

from __future__ import annotations

import asyncio
import logging
import os
import time
from datetime import datetime, timezone
from typing import Any

from livekit.protocol.egress import (
    EncodedFileOutput,
    EncodedFileType,
    ListEgressRequest,
    RoomCompositeEgressRequest,
    S3Upload,
    StopEgressRequest,
)

logger = logging.getLogger(__name__)


def s3_egress_enabled() -> bool:
    bucket = os.getenv("AWS_S3_BUCKET") or os.getenv("S3_BUCKET")
    return (
        os.getenv("ENABLE_RECORDING", "true").lower() in ("1", "true", "yes")
        and bool(bucket)
    )


def build_s3_key(org_id: str, room_name: str, filename: str) -> str:
    prefix = os.getenv("S3_BASE_PREFIX", "trainertwin-dev").strip("/")
    now = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    return f"{prefix}/{org_id}/recordings/{room_name}_{now}/{filename}"


def build_s3_url(bucket: str, key: str, region: str) -> str:
    return f"https://{bucket}.s3.{region}.amazonaws.com/{key}"


async def start_session_egress(
    *,
    lk_api: Any,
    org_id: str,
    room_name: str,
) -> dict[str, str | None]:
    if not s3_egress_enabled():
        return {}

    bucket = os.getenv("AWS_S3_BUCKET") or os.getenv("S3_BUCKET", "")
    region = os.getenv("AWS_REGION", "us-east-1")
    access_key = os.getenv("AWS_ACCESS_KEY_ID", "")
    secret_key = os.getenv("AWS_SECRET_ACCESS_KEY", "")

    audio_s3_key = build_s3_key(org_id, room_name, "audio.mp4")
    video_s3_key = build_s3_key(org_id, room_name, "video.mp4")
    audio_url = build_s3_url(bucket, audio_s3_key, region)
    video_url = build_s3_url(bucket, video_s3_key, region)

    audio_egress_id: str | None = None
    video_egress_id: str | None = None

    async def _start_audio():
        nonlocal audio_egress_id
        try:
            req = RoomCompositeEgressRequest(
                room_name=room_name,
                audio_only=True,
                file_outputs=[
                    EncodedFileOutput(
                        file_type=EncodedFileType.MP4,
                        filepath=audio_s3_key,
                        s3=S3Upload(
                            access_key=access_key,
                            secret=secret_key,
                            region=region,
                            bucket=bucket,
                        ),
                    )
                ],
            )
            resp = await asyncio.wait_for(lk_api.egress.start_room_composite_egress(req), timeout=15)
            audio_egress_id = resp.egress_id
            logger.info("Started audio egress %s for room %s", audio_egress_id, room_name)
        except Exception as exc:
            logger.error("Failed to start audio egress for %s: %s", room_name, exc)

    async def _start_video():
        nonlocal video_egress_id
        try:
            req = RoomCompositeEgressRequest(
                room_name=room_name,
                audio_only=False,
                file_outputs=[
                    EncodedFileOutput(
                        file_type=EncodedFileType.MP4,
                        filepath=video_s3_key,
                        s3=S3Upload(
                            access_key=access_key,
                            secret=secret_key,
                            region=region,
                            bucket=bucket,
                        ),
                    )
                ],
            )
            resp = await asyncio.wait_for(lk_api.egress.start_room_composite_egress(req), timeout=15)
            video_egress_id = resp.egress_id
            logger.info("Started video egress %s for room %s", video_egress_id, room_name)
        except Exception as exc:
            logger.error("Failed to start video egress for %s: %s", room_name, exc)

    await _start_audio()
    await _start_video()

    return {
        "audio_egress_id": audio_egress_id,
        "video_egress_id": video_egress_id,
        "audio_url": audio_url if audio_egress_id else None,
        "video_url": video_url if video_egress_id else None,
        "audio_s3_key": audio_s3_key if audio_egress_id else None,
        "video_s3_key": video_s3_key if video_egress_id else None,
    }


async def stop_and_poll_egress(lk_api: Any, egress_id: str, timeout: float = 30.0) -> bool:
    try:
        await lk_api.egress.stop_egress(StopEgressRequest(egress_id=egress_id))
    except Exception as exc:
        logger.warning("Stop egress %s error: %s", egress_id, exc)

    start = time.monotonic()
    while time.monotonic() - start < timeout:
        await asyncio.sleep(2.0)
        try:
            resp = await lk_api.egress.list_egress(ListEgressRequest(egress_id=egress_id))
            for item in resp.items:
                if item.egress_id == egress_id:
                    if item.status in (3, 4):  # EGRESS_COMPLETE, EGRESS_FAILED
                        return item.status == 3
        except Exception:
            pass
    return False
