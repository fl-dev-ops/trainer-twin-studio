"""Recording management and webhook posting."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from livekit import agents

from infrastructure.config.profiles import AgentProfile
from domains.recording.config import RecordingConfig
from domains.recording.egress.manager import finalize_recording, start_recording

from .config import RecordingStartState

logger = logging.getLogger("intervoo_agent")


async def start_recording_for_session(
    *,
    config: RecordingConfig,
    ctx: agents.JobContext,
    profile: AgentProfile,
    room_name: str,
    resolved_user_id: str | None,
    participant_identity: str | None,
    phone_number: str | None,
    metadata: dict[str, object],
) -> RecordingStartState:
    if not config.enabled:
        return RecordingStartState()

    try:
        (
            recording_session_id,
            audio_url,
            audio_s3_key,
            egress_id,
            video_url,
            video_s3_key,
            video_egress_id,
        ) = await start_recording(
            config=config,
            lk_api=ctx.api,
            agent_type=profile.agent_type,
            agent_name=profile.agent_type,
            room_name=room_name,
            resolved_user_id=resolved_user_id,
            participant_identity=participant_identity,
            phone_number=phone_number,
            metadata=metadata,
        )
        return RecordingStartState(
            recording_session_id=recording_session_id,
            audio_url=audio_url,
            audio_s3_key=audio_s3_key,
            egress_id=egress_id,
            video_url=video_url,
            video_s3_key=video_s3_key,
            video_egress_id=video_egress_id,
        )
    except Exception as e:
        logger.error("Failed to initialize recording: %s", e)
        return RecordingStartState()


async def post_webhook(
    webhook_url: str,
    payload: dict[str, Any],
) -> None:
    from urllib import error, request

    def _send() -> None:
        body = json.dumps(payload, default=str).encode("utf-8")
        logger.info("Posting webhook to %s", webhook_url)
        req = request.Request(
            webhook_url,
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with request.urlopen(req, timeout=30) as response:
            status = getattr(response, "status", response.getcode())
            if status >= 400:
                raise RuntimeError(f"Webhook returned status {status}")

    try:
        await asyncio.to_thread(_send)
        logger.info("Webhook delivered to %s", webhook_url)
    except error.HTTPError as e:
        response_body = ""
        try:
            response_body = e.read().decode("utf-8", errors="replace")
        except Exception:
            pass
        logger.error(
            "Webhook failed for %s with HTTP %s: %s%s",
            webhook_url,
            e.code,
            e.reason,
            f" body={response_body}" if response_body else "",
        )
    except Exception as e:
        logger.error("Webhook delivery failed for %s: %s", webhook_url, e)


async def finalize_recording_session(
    state: Any,
    ctx: agents.JobContext,
    report_dict: dict,
) -> dict[str, object] | None:
    if state.recording_config is None:
        return None

    try:
        return await finalize_recording(
            config=state.recording_config,
            lk_api=ctx.api,
            egress_id=state.egress_id,
            session_id=state.recording_session_id,
            agent_type=state.profile.agent_type,
            agent_name=state.profile.agent_type,
            room_name=state.room_name,
            audio_url=state.audio_url,
            audio_s3_key=state.audio_s3_key,
            report_dict=report_dict,
            resolved_user_id=state.resolved_user_id,
            participant_identity=state.participant_identity,
            phone_number=state.phone_number,
            webhook_url=state.webhook_url,
            send_webhook=False,
            video_egress_id=state.video_egress_id,
            video_url=state.video_url,
            video_s3_key=state.video_s3_key,
        )
    except Exception as e:
        logger.error(f"Recording finalization failed: {e}")
        return None


async def post_completion_webhook(
    state: Any,
    recording_result: dict[str, object] | None,
    report_dict: dict,
) -> None:
    if not state.webhook_url:
        return

    try:
        transcript_data = (
            recording_result.get("transcript") if recording_result else None
        )
        if transcript_data is None:
            try:
                from domains.recording.transcript.normalizer import normalize_session_report

                transcript_data = normalize_session_report(
                    report_dict,
                    agent_type=state.profile.agent_type,
                    agent_name=state.profile.agent_type,
                    resolved_user_id=state.resolved_user_id,
                    participant_identity=state.participant_identity,
                    phone_number=state.phone_number,
                )
            except Exception:
                pass

        payload = {
            "agent_id": state.profile.id,
            "agent_type": state.profile.agent_type,
            "room_name": state.room_name,
            "audio_url": recording_result.get("audio_url")
            if recording_result
            else state.audio_url,
            "video_url": recording_result.get("video_url")
            if recording_result
            else state.video_url,
            "transcript_url": recording_result.get("transcript_url")
            if recording_result
            else None,
            "verbose_url": recording_result.get("verbose_url")
            if recording_result
            else None,
            "transcript": transcript_data,
            "duration_ms": recording_result.get("duration_ms")
            if recording_result
            else None,
            "status": recording_result.get("status")
            if recording_result
            else "COMPLETED",
        }
        if recording_result:
            for url_key in (
                "audio_url",
                "transcript_url",
                "metrics_url",
                "verbose_url",
            ):
                url = recording_result.get(url_key)
                if isinstance(url, str) and url:
                    logger.info("%s", url)
        await post_webhook(state.webhook_url, payload)
    except Exception as e:
        logger.error(f"Failed to post completion webhook: {e}")
