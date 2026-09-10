"""Recording egress management for LiveKit sessions."""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Any
from urllib import error, request

from livekit import api
from livekit.protocol.egress import (
    EgressStatus,
    EncodedFileOutput,
    EncodedFileType,
    ListEgressRequest,
    RoomCompositeEgressRequest,
    S3Upload,
    StopEgressRequest,
)

from domains.recording.config import RecordingConfig
from domains.recording.storage.db import (
    insert_session,
    update_session_completed,
    update_session_finalizing,
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
from domains.recording.transcript.normalizer import (
    normalize_metrics_payload,
    normalize_session_report,
    normalize_verbose_payload,
)

logger = logging.getLogger(__name__)

TERMINAL_STATUSES = {
    EgressStatus.EGRESS_COMPLETE,
    EgressStatus.EGRESS_FAILED,
    EgressStatus.EGRESS_ABORTED,
    EgressStatus.EGRESS_LIMIT_REACHED,
}


def _build_s3_upload(config: RecordingConfig) -> S3Upload:
    if not config.s3_access_key or not config.s3_secret_key:
        raise ValueError(
            "AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are required for "
            "LiveKit Cloud egress uploads"
        )
    kwargs: dict[str, Any] = {
        "access_key": config.s3_access_key,
        "secret": config.s3_secret_key,
        "region": config.s3_region,
        "bucket": config.s3_bucket,
    }
    if config.s3_endpoint:
        kwargs["endpoint"] = config.s3_endpoint
    if config.s3_force_path_style:
        kwargs["force_path_style"] = True
    return S3Upload(**kwargs)


async def start_recording(
    *,
    config: RecordingConfig,
    lk_api: api.LiveKitAPI | None = None,
    agent_type: str,
    agent_name: str,
    room_name: str,
    room_sid: str | None = None,
    resolved_user_id: str | None = None,
    participant_identity: str | None = None,
    phone_number: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> tuple[
    str | None,
    str | None,
    str | None,
    str | None,
    str | None,
    str | None,
    str | None,
]:
    now = datetime.now(timezone.utc)
    audio_s3_key = build_audio_s3_key(agent_type, room_name, config.s3_base_prefix, now)
    audio_url = build_s3_url(
        config.s3_bucket, audio_s3_key, config.s3_region, config.s3_endpoint
    )
    video_s3_key = build_video_s3_key(agent_type, room_name, config.s3_base_prefix, now)
    video_url = build_s3_url(
        config.s3_bucket, video_s3_key, config.s3_region, config.s3_endpoint
    )

    audio_egress_id: str | None = None
    video_egress_id: str | None = None

    s3_upload = _build_s3_upload(config)

    async def _start_audio_egress() -> None:
        nonlocal audio_egress_id
        try:
            file_output = EncodedFileOutput(
                file_type=EncodedFileType.MP3,
                filepath=audio_s3_key,
                s3=s3_upload,
            )
            async with api.LiveKitAPI() as fresh_api:
                egress_info = await asyncio.wait_for(
                    fresh_api.egress.start_room_composite_egress(
                        RoomCompositeEgressRequest(
                            room_name=room_name,
                            audio_only=True,
                            file_outputs=[file_output],
                        )
                    ),
                    timeout=config.egress_start_timeout_seconds,
                )
            audio_egress_id = egress_info.egress_id
            logger.info(f"Started audio egress {audio_egress_id} for room {room_name}")
        except Exception as e:
            logger.error(f"Failed to start audio egress for room {room_name}: {e}")

    async def _start_video_egress() -> None:
        nonlocal video_egress_id
        try:
            file_output = EncodedFileOutput(
                file_type=EncodedFileType.MP4,
                filepath=video_s3_key,
                s3=s3_upload,
            )
            async with api.LiveKitAPI() as fresh_api:
                egress_info = await asyncio.wait_for(
                    fresh_api.egress.start_room_composite_egress(
                        RoomCompositeEgressRequest(
                            room_name=room_name,
                            audio_only=False,
                            file_outputs=[file_output],
                        )
                    ),
                    timeout=config.egress_start_timeout_seconds,
                )
            video_egress_id = egress_info.egress_id
            logger.info(f"Started video egress {video_egress_id} for room {room_name}")
        except Exception as e:
            logger.error(f"Failed to start video egress for room {room_name}: {e}")

    await _start_audio_egress()
    await _start_video_egress()

    if audio_egress_id is None:
        audio_url = None
        audio_s3_key = None
    if video_egress_id is None:
        video_url = None
        video_s3_key = None

    session_id: str | None = None
    if config.database_url:
        try:
            session_id = await asyncio.wait_for(
                insert_session(
                    agent_type=agent_type,
                    agent_name=agent_name,
                    livekit_room_name=room_name,
                    livekit_room_sid=room_sid,
                    egress_id=audio_egress_id,
                    resolved_user_id=resolved_user_id,
                    participant_identity=participant_identity,
                    phone_number=phone_number,
                    started_at=now,
                    audio_url=audio_url,
                    audio_s3_key=audio_s3_key,
                    video_url=video_url,
                    video_s3_key=video_s3_key,
                    video_egress_id=video_egress_id,
                    metadata=metadata,
                ),
                timeout=10,
            )
        except Exception as e:
            logger.error(f"Failed to insert session row: {e}")

    return (
        session_id,
        audio_url,
        audio_s3_key,
        audio_egress_id,
        video_url,
        video_s3_key,
        video_egress_id,
    )


def _build_webhook_payload(
    *,
    agent_type: str,
    agent_name: str,
    room_name: str,
    egress_id: str | None,
    egress_status: str | None,
    final_status: str,
    audio_url: str | None,
    audio_s3_key: str | None,
    video_url: str | None,
    video_s3_key: str | None,
    transcript_url: str | None,
    transcript_s3_key: str | None,
    metrics_url: str | None,
    metrics_s3_key: str | None,
    verbose_url: str | None,
    verbose_s3_key: str | None,
    duration_ms: int | None,
    report_dict: dict[str, Any],
    transcript_data: dict[str, Any] | None,
    resolved_user_id: str | None,
    participant_identity: str | None,
    phone_number: str | None,
) -> dict[str, Any]:
    return {
        "agent_type": agent_type,
        "agent_name": agent_name,
        "room_name": room_name,
        "room_id": report_dict.get("room_id"),
        "job_id": report_dict.get("job_id"),
        "status": final_status,
        "egress_id": egress_id,
        "egress_status": egress_status,
        "audio_url": audio_url,
        "audio_s3_key": audio_s3_key,
        "video_url": video_url,
        "video_s3_key": video_s3_key,
        "transcript_url": transcript_url,
        "transcript_s3_key": transcript_s3_key,
        "metrics_url": metrics_url,
        "metrics_s3_key": metrics_s3_key,
        "verbose_url": verbose_url,
        "verbose_s3_key": verbose_s3_key,
        "duration_ms": duration_ms,
        "started_at": transcript_data.get("session", {}).get("started_at")
        if transcript_data
        else None,
        "ended_at": transcript_data.get("session", {}).get("ended_at")
        if transcript_data
        else None,
        "resolved_user_id": resolved_user_id,
        "participant_identity": participant_identity,
        "phone_number": phone_number,
        "transcript": transcript_data,
    }


async def _post_completion_webhook(
    config: RecordingConfig,
    payload: dict[str, Any],
    webhook_url: str | None = None,
) -> None:
    target_url = webhook_url or config.webhook_url
    if not target_url:
        return

    def _send() -> None:
        body = json.dumps(payload, default=str).encode("utf-8")
        webhook_request = request.Request(
            target_url,
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with request.urlopen(webhook_request, timeout=10) as response:
            status_code = getattr(response, "status", response.getcode())
            if status_code >= 400:
                raise RuntimeError(f"Webhook returned status {status_code}")

    try:
        await asyncio.to_thread(_send)
        logger.info("Recording webhook delivered to %s", target_url)
    except error.HTTPError as e:
        logger.error("Recording webhook failed with HTTP %s: %s", e.code, e.reason)
    except Exception as e:
        logger.error(f"Recording webhook delivery failed: {e}")


async def _stop_and_poll_egress(
    *,
    egress_id: str,
    timeout: int,
    label: str,
) -> tuple[str | None, bool, bool]:
    async with api.LiveKitAPI() as lk:
        try:
            await asyncio.wait_for(
                lk.egress.stop_egress(StopEgressRequest(egress_id=egress_id)),
                timeout=timeout,
            )
        except Exception as e:
            logger.error("Failed to stop %s egress %s: %s", label, egress_id, e)

        elapsed = 0
        poll_interval = 2
        while elapsed < timeout:
            try:
                list_resp = await lk.egress.list_egress(
                    ListEgressRequest(room_name="")
                )
                for info in list_resp.items:
                    if info.egress_id == egress_id:
                        status = info.status
                        if status in TERMINAL_STATUSES:
                            is_failed = status in {
                                EgressStatus.EGRESS_FAILED,
                                EgressStatus.EGRESS_ABORTED,
                            }
                            return (
                                info.error or None,
                                not is_failed,
                                is_failed,
                            )
            except Exception as e:
                logger.warning("Egress poll error for %s: %s", label, e)

            await asyncio.sleep(poll_interval)
            elapsed += poll_interval

        logger.warning("Egress poll timeout for %s %s", label, egress_id)
        return None, False, True


async def finalize_recording(
    *,
    config: RecordingConfig,
    lk_api: api.LiveKitAPI | None = None,
    egress_id: str | None,
    session_id: str | None,
    agent_type: str,
    agent_name: str,
    room_name: str,
    audio_url: str | None,
    audio_s3_key: str | None,
    report_dict: dict[str, Any],
    resolved_user_id: str | None,
    participant_identity: str | None,
    phone_number: str | None,
    webhook_url: str | None = None,
    send_webhook: bool = True,
    video_egress_id: str | None = None,
    video_url: str | None = None,
    video_s3_key: str | None = None,
) -> dict[str, Any]:
    if session_id is not None:
        try:
            await update_session_finalizing(session_id)
        except Exception as e:
            logger.error("Failed to mark session finalizing: %s", e)

    audio_error: str | None = None
    audio_ok = True
    if egress_id is not None:
        audio_error, audio_ok, _ = await _stop_and_poll_egress(
            egress_id=egress_id,
            timeout=config.egress_poll_timeout_seconds,
            label="audio",
        )

    video_error: str | None = None
    video_ok = True
    if video_egress_id is not None:
        video_error, video_ok, _ = await _stop_and_poll_egress(
            egress_id=video_egress_id,
            timeout=config.egress_poll_timeout_seconds,
            label="video",
        )

    egress_status = "COMPLETED"
    egress_error = audio_error or video_error
    if not audio_ok or not video_ok:
        egress_status = "FAILED"

    transcript_url: str | None = None
    transcript_s3_key: str | None = None
    metrics_url: str | None = None
    metrics_s3_key: str | None = None
    verbose_url: str | None = None
    verbose_s3_key: str | None = None
    duration_ms: int | None = None
    transcript_data: dict[str, Any] | None = None

    now = datetime.now(timezone.utc)
    duration = report_dict.get("duration")
    if duration is not None:
        duration_ms = int(duration * 1000)

    if audio_ok and config.database_url:
        transcript_data = normalize_session_report(
            report_dict,
            agent_type=agent_type,
            agent_name=agent_name,
            egress_id=egress_id,
            egress_status=egress_status,
            resolved_user_id=resolved_user_id,
            participant_identity=participant_identity,
            phone_number=phone_number,
        )
        transcript_s3_key = build_transcript_s3_key(agent_type, room_name, config.s3_base_prefix, now)
        try:
            transcript_url = upload_transcript_json(config, transcript_s3_key, transcript_data)
        except Exception as e:
            logger.error("Failed to upload transcript: %s", e)

        metrics_data = normalize_metrics_payload(
            report_dict,
            agent_type=agent_type,
            agent_name=agent_name,
            egress_id=egress_id,
            egress_status=egress_status,
            resolved_user_id=resolved_user_id,
            participant_identity=participant_identity,
            phone_number=phone_number,
        )
        metrics_s3_key = build_metrics_s3_key(agent_type, room_name, config.s3_base_prefix, now)
        try:
            metrics_url = upload_metrics_json(config, metrics_s3_key, metrics_data)
        except Exception as e:
            logger.error("Failed to upload metrics: %s", e)

        verbose_data = normalize_verbose_payload(
            report_dict,
            agent_type=agent_type,
            agent_name=agent_name,
            egress_id=egress_id,
            egress_status=egress_status,
            resolved_user_id=resolved_user_id,
            participant_identity=participant_identity,
            phone_number=phone_number,
        )
        verbose_s3_key = build_verbose_s3_key(agent_type, room_name, config.s3_base_prefix, now)
        try:
            verbose_url = upload_verbose_json(config, verbose_s3_key, verbose_data)
        except Exception as e:
            logger.error("Failed to upload verbose report: %s", e)

    if session_id is not None:
        try:
            await update_session_completed(
                session_id,
                ended_at=now,
                duration_ms=duration_ms,
                transcript_url=transcript_url,
                transcript_s3_key=transcript_s3_key,
                metrics_url=metrics_url,
                metrics_s3_key=metrics_s3_key,
                verbose_url=verbose_url,
                verbose_s3_key=verbose_s3_key,
                video_url=video_url,
                video_s3_key=video_s3_key,
                egress_status=egress_status,
                egress_error=egress_error,
            )
        except Exception as e:
            logger.error("Failed to update session completed: %s", e)

    if send_webhook and config.webhook_url:
        payload = _build_webhook_payload(
            agent_type=agent_type,
            agent_name=agent_name,
            room_name=room_name,
            egress_id=egress_id,
            egress_status=egress_status,
            final_status="COMPLETED" if audio_ok and video_ok else "FAILED",
            audio_url=audio_url,
            audio_s3_key=audio_s3_key,
            video_url=video_url,
            video_s3_key=video_s3_key,
            transcript_url=transcript_url,
            transcript_s3_key=transcript_s3_key,
            metrics_url=metrics_url,
            metrics_s3_key=metrics_s3_key,
            verbose_url=verbose_url,
            verbose_s3_key=verbose_s3_key,
            duration_ms=duration_ms,
            report_dict=report_dict,
            transcript_data=transcript_data,
            resolved_user_id=resolved_user_id,
            participant_identity=participant_identity,
            phone_number=phone_number,
        )
        await _post_completion_webhook(config, payload, webhook_url)

    return {
        "status": "COMPLETED" if audio_ok and video_ok else "FAILED",
        "egress_id": egress_id,
        "egress_status": egress_status,
        "egress_error": egress_error,
        "audio_url": audio_url,
        "audio_s3_key": audio_s3_key,
        "video_url": video_url,
        "video_s3_key": video_s3_key,
        "transcript_url": transcript_url,
        "transcript_s3_key": transcript_s3_key,
        "metrics_url": metrics_url,
        "metrics_s3_key": metrics_s3_key,
        "verbose_url": verbose_url,
        "verbose_s3_key": verbose_s3_key,
        "duration_ms": duration_ms,
        "transcript": transcript_data,
    }
