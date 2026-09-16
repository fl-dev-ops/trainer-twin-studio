"""TrainerTwin LiveKit Voice Agent Worker."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import os
import sys
import time
from typing import Any

from dotenv import load_dotenv
from livekit import agents, api, rtc
from livekit.agents import Agent, room_io
from livekit.plugins import noise_cancellation

from pathlib import Path

from recording import (
    post_completion_webhook,
    start_session_egress,
    stop_and_poll_egress,
)
from session import build_agent_session
from tools import build_interview_tools

load_dotenv(override=True)

# Trust the local portless CA for https://*.localhost if present. Use the
# combined bundle (system roots + portless CA) — a CA-only file would break
# TLS to LiveKit/Sarvam/AWS. setup.sh builds the bundle.
_ca_bundle = os.path.expanduser("~/.portless/ca-bundle.pem")
_ca_only = os.path.expanduser("~/.portless/ca.pem")
_default_ca = _ca_bundle if os.path.exists(_ca_bundle) else _ca_only
if os.path.exists(_default_ca) and "SSL_CERT_FILE" not in os.environ:
    os.environ["SSL_CERT_FILE"] = _default_ca

logger = logging.getLogger("trainertwin_agent")
logging.basicConfig(level=logging.INFO)

# Transport-only prompt. The configured remote brain owns all behavioral and session instructions.
COMMON_VOICE_PROMPT_PATH = Path(__file__).with_name("prompt.md")
COMMON_VOICE_INSTRUCTIONS = COMMON_VOICE_PROMPT_PATH.read_text(encoding="utf-8").strip()

AGENT_NAME = os.getenv("AGENT_NAME", "intervoo-agent")
WEB_URL = os.getenv("WEB_URL", "http://localhost:3000").rstrip("/")
_sessions: dict[str, dict[str, Any]] = {}

REQUIRED_ENV_VARS = (
    "LIVEKIT_URL",
    "LIVEKIT_API_KEY",
    "LIVEKIT_API_SECRET",
    "AGENT_NAME",
    "WEB_URL",
    "LLM_BASE_URL",
    "DEEPGRAM_API_KEY",
    "TTS_PROVIDER",
    "SARVAM_API_KEY",
    "AWS_REGION",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
)


def validate_environment() -> None:
    missing = [k for k in REQUIRED_ENV_VARS if not os.getenv(k, "").strip()]
    if not (os.getenv("AWS_S3_BUCKET", "").strip() or os.getenv("S3_BUCKET", "").strip()):
        missing.append("AWS_S3_BUCKET/S3_BUCKET")
    if missing:
        print(f"Missing required environment variables: {', '.join(missing)}", file=sys.stderr)
        sys.exit(1)


def parse_metadata(raw: str | None) -> dict[str, Any]:
    if not raw or not raw.strip():
        return {}
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


# Client gated on the intro video: the greeting releases on "begin-opening". The fixed
# 60s cap keeps dead clients (refresh loops, broken video) from stalling sessions; keep
# intro clips comfortably under it.
OPENING_RELEASE_TIMEOUT = 60.0
MCQ_SUBMISSION_PREFIX = "__TRAINERTWIN_MCQ_SUBMISSION__:"
CODE_SUBMISSION_PREFIX = "__TRAINERTWIN_CODE_SUBMISSION__:"
WHITEBOARD_SUBMISSION_PREFIX = "__TRAINERTWIN_WHITEBOARD_SUBMISSION__:"
# The common voice prompt lives in prompt.md next to this file and is loaded
# at import time (see COMMON_VOICE_INSTRUCTIONS above).


class TrainerAgent(Agent):
    """Voice transport that delegates conversation flow to the configured TrainerTwin brain."""

    def __init__(
        self,
        *,
        tools: list[Any],
        room_name: str,
        opening_release: asyncio.Event,
        hold_opening: bool = False,
    ) -> None:
        super().__init__(
            instructions=COMMON_VOICE_INSTRUCTIONS,
            tools=tools,
        )
        self.room_name = room_name
        self.opening_release = opening_release
        self.hold_opening = hold_opening

    async def on_enter(self) -> None:
        # When the scenario ships an intro clip (hold_opening room metadata), the client
        # plays it inside the session and sends {"type": "begin-opening"} when it ends so
        # the first speech picks up seamlessly instead of talking over the clip. Without
        # the flag the greeting starts immediately (old-client / rollout-skew safe). A
        # timeout keeps dead clients (refresh loops, broken video) from stalling sessions.
        if not self.hold_opening:
            await self._generate_opening()
            return
        logger.info("TrainerAgent entered room %s, waiting for opening release", self.room_name)
        try:
            await asyncio.wait_for(self.opening_release.wait(), timeout=OPENING_RELEASE_TIMEOUT)
        except asyncio.TimeoutError:
            logger.warning(
                "No opening release after %.0fs for room %s; speaking anyway",
                OPENING_RELEASE_TIMEOUT,
                self.room_name,
            )
        await self._generate_opening()

    async def _generate_opening(self) -> None:
        try:
            await self.session.generate_reply(instructions="session-start")
        except Exception as exc:
            logger.exception("Failed to generate initial reply: %s", exc)



async def entrypoint(ctx: agents.JobContext) -> None:
    raw_meta = ctx.job.metadata or ctx.job.room.metadata or ctx.room.metadata
    metadata = parse_metadata(raw_meta)

    session_id = str(metadata.get("sessionId") or metadata.get("session_id") or ctx.room.name).strip()
    runtime_token = str(metadata.get("runtimeToken") or metadata.get("runtime_token") or "").strip()
    if not runtime_token:
        logger.error("Runtime token missing from job metadata for session %s", session_id)
        return
    voice = str(metadata.get("voice") or "").strip()
    org_id = str(metadata.get("orgId") or metadata.get("org_id") or "shared").strip()

    # ponytail: webhook path hardcoded; if another endpoint is ever needed, pass it via room metadata
    webhook_raw = str(metadata.get("webhook_url") or "").strip()
    if webhook_raw.startswith("/"):
        webhook_url = f"{WEB_URL}{webhook_raw}"
    else:
        webhook_url = webhook_raw or f"{WEB_URL}/api/sessions/webhook"

    # Client holds the greeting until its intro video finishes; released via data packet. The
    # listener is attached BEFORE connecting: the client publishes "begin-opening" as soon as it
    # sees this participant, so a listener registered after connect can miss the single packet the
    # client sends and leave the session silent until OPENING_RELEASE_TIMEOUT.
    opening_release = asyncio.Event()
    active_session: Any = None
    pending_chat_messages: list[str] = []
    pending_code_submissions: dict[str, dict[str, Any]] = {}
    accepted_whiteboard_signatures: set[str] = set()
    participant_identity: str | None = None

    def submit_user_input(text: str) -> None:
        if active_session is not None:
            asyncio.create_task(active_session.generate_reply(user_input=text))
        else:
            pending_chat_messages.append(text)

    def on_data_received(packet: rtc.DataPacket) -> None:
        try:
            msg = json.loads(packet.data)
        except Exception:
            return
        if not isinstance(msg, dict):
            return
        msg_type = msg.get("type")
        if msg_type == "begin-opening":
            opening_release.set()
        elif msg_type == "chat-message":
            text = str(msg.get("text") or "").strip()
            if text:
                logger.info("Received chat message from participant: %s", text[:80])
                submit_user_input(text)
        elif msg_type == "mcq-submission" and msg.get("submitted") is True:
            option_id = str(msg.get("optionId") or "").strip()
            option_text = str(msg.get("optionText") or "").strip()
            question_id = str(msg.get("questionId") or "").strip()
            if question_id and option_id and option_text and len(option_text) <= 2_000:
                logger.info("Received MCQ submission question_id=%s option_id=%s", question_id[:80], option_id[:20])
                submit_user_input(
                    MCQ_SUBMISSION_PREFIX
                    + json.dumps(
                        {
                            "questionId": question_id,
                            "optionId": option_id,
                            "optionText": option_text,
                        },
                        separators=(",", ":"),
                    )
                )
        elif msg_type == "whiteboard-evaluation":
            payload = msg.get("payload")
            signature = msg.get("signature")
            if not isinstance(payload, str) or not isinstance(signature, str):
                return
            signing_secret = (
                os.getenv("WHITEBOARD_EVALUATION_SIGNING_SECRET", "").strip()
                or os.getenv("LIVEKIT_API_SECRET", "").strip()
            )
            expected_signature = hmac.new(
                signing_secret.encode("utf-8"),
                payload.encode("utf-8"),
                hashlib.sha256,
            ).hexdigest()
            try:
                assessment = json.loads(payload)
            except Exception:
                return
            if not isinstance(assessment, dict):
                return
            question_id = str(assessment.get("questionId") or "").strip()
            revision = assessment.get("revision")
            evaluated_at = assessment.get("evaluatedAt")
            accepted = (
                bool(signing_secret)
                and hmac.compare_digest(expected_signature, signature)
                and signature not in accepted_whiteboard_signatures
                and assessment.get("version") == 1
                and assessment.get("roomName") == ctx.room.name
                and assessment.get("participantIdentity") == participant_identity
                and bool(question_id)
                and isinstance(revision, int)
                and isinstance(evaluated_at, int)
                and abs(int(time.time() * 1000) - evaluated_at) <= 10 * 60 * 1000
                and assessment.get("evaluationStatus") == "completed"
            )
            if accepted:
                accepted_whiteboard_signatures.add(signature)

            async def acknowledge_whiteboard() -> None:
                await ctx.room.local_participant.publish_data(
                    json.dumps(
                        {
                            "type": "whiteboard_answer_status",
                            "questionId": question_id,
                            "revision": revision if isinstance(revision, int) else 0,
                            "status": "accepted" if accepted else "rejected",
                            **({} if accepted else {"message": "The whiteboard assessment could not be verified."}),
                        }
                    ).encode("utf-8"),
                    reliable=True,
                )
                if accepted:
                    logger.info("Received verified whiteboard assessment question_id=%s", question_id[:80])
                    submit_user_input(WHITEBOARD_SUBMISSION_PREFIX + payload)

            asyncio.create_task(acknowledge_whiteboard())
        elif msg_type == "code-submission":
            submission_id = str(msg.get("submissionId") or "").strip()
            question_id = str(msg.get("questionId") or "").strip()
            language = str(msg.get("language") or "text").strip()[:40]
            index = msg.get("index")
            total = msg.get("total")
            chunk = msg.get("chunk")
            if (
                not submission_id
                or not isinstance(index, int)
                or not isinstance(total, int)
                or total < 1
                or total > 10
                or index < 0
                or index >= total
                or not isinstance(chunk, str)
            ):
                return
            if submission_id not in pending_code_submissions and len(pending_code_submissions) >= 20:
                return
            pending = pending_code_submissions.setdefault(
                submission_id,
                {"question_id": question_id, "language": language, "total": total, "chunks": {}},
            )
            if pending["total"] != total or pending["question_id"] != question_id:
                pending_code_submissions.pop(submission_id, None)
                return
            pending["chunks"][index] = chunk
            if len(pending["chunks"]) == total:
                code = "".join(pending["chunks"][part] for part in range(total))
                pending_code_submissions.pop(submission_id, None)
                if len(code) > 20000:
                    return
                logger.info("Received code submission question_id=%s language=%s chars=%s", question_id[:80], language, len(code))
                submit_user_input(
                    CODE_SUBMISSION_PREFIX
                    + json.dumps(
                        {
                            "questionId": question_id,
                            "language": language,
                            "code": code,
                        },
                        separators=(",", ":"),
                    )
                )

    ctx.room.on("data_received", on_data_received)

    await ctx.connect()
    logger.info("Agent connected to room %s for session %s", ctx.room.name, session_id)

    for _ in range(60):
        for p in ctx.room.remote_participants.values():
            participant_identity = p.identity
            break
        if participant_identity:
            break
        await asyncio.sleep(0.5)

    if not participant_identity:
        participant_identity = f"candidate-{session_id}"

    # Start optional S3 recording egress
    egress_data = await start_session_egress(lk_api=ctx.api, org_id=org_id, room_name=ctx.room.name)

    tools = build_interview_tools(room=ctx.room, participant_identity=participant_identity)

    agent_slug = str(metadata.get("agent_id") or metadata.get("agentSlug") or "").strip()
    extra_headers: dict[str, str] = {
        "x-trainertwin-session-id": session_id,
        "x-trainertwin-org-id": org_id,
        "x-trainertwin-agent-slug": agent_slug,
        "x-trainertwin-mode": "voice",
    }
    copilot_secret = os.getenv("COPILOT_SERVICE_SECRET", "").strip()
    # Only the chat bridge wants Basic org:secret. The web runtime must keep the
    # runtime-token Bearer (api_key) — per-request headers override the client's
    # default Authorization, so Basic here would break web-runtime auth (401).
    llm_base = (os.getenv("LLM_BASE_URL") or f"{WEB_URL}/api/v1").rstrip("/")
    if copilot_secret and org_id and not llm_base.endswith("/api/v1"):
        import base64
        b64_auth = base64.b64encode(f"{org_id}:{copilot_secret}".encode()).decode()
        extra_headers["Authorization"] = f"Basic {b64_auth}"

    session = build_agent_session(
        api_key=runtime_token,
        voice=voice,
        extra_headers=extra_headers,
    )

    _sessions[ctx.room.name] = {
        "session_id": session_id,
        "runtime_token": runtime_token,
        "webhook_url": webhook_url,
        "participant_identity": participant_identity,
        "audio_egress_id": egress_data.get("audio_egress_id"),
        "video_egress_id": egress_data.get("video_egress_id"),
        "audio_url": egress_data.get("audio_url"),
        "video_url": egress_data.get("video_url"),
        "audio_s3_key": egress_data.get("audio_s3_key"),
        "video_s3_key": egress_data.get("video_s3_key"),
        "session": session,  # kept in-memory so on_session_end can dump the transcript
    }

    agent = TrainerAgent(
        tools=tools,
        room_name=ctx.room.name,
        opening_release=opening_release,
        hold_opening=bool(metadata.get("hold_opening")),
    )

    async def watch_empty_room() -> None:
        """Tab death skips finalize AND the job lingers (close_on_disconnect=False).
        After a 30s grace (page refreshes reconnect), tear the room down so
        on_session_end fires and the session row doesn't stay 'active' forever."""
        while True:
            await asyncio.sleep(5)
            if ctx.room.remote_participants:
                continue
            for _ in range(6):
                await asyncio.sleep(5)
                if ctx.room.remote_participants:
                    break
            else:
                state = _sessions.get(ctx.room.name)
                if state is not None:
                    state["end_status"] = "ABANDONED"
                logger.info("Room %s empty for 30s; ending abandoned session", ctx.room.name)
                try:
                    await ctx.api.room.delete_room(api.DeleteRoomRequest(room=ctx.room.name))
                except Exception as exc:
                    logger.debug("Room teardown note: %s", exc)
                return

    active_session = session
    await session.start(
        room=ctx.room,
        agent=agent,
        room_options=room_io.RoomOptions(
            audio_input=room_io.AudioInputOptions(
                noise_cancellation=noise_cancellation.BVC(),
            ),
            close_on_disconnect=False,
        ),
    )
    for pending_text in pending_chat_messages:
        asyncio.create_task(session.generate_reply(user_input=pending_text))
    pending_chat_messages.clear()
    asyncio.create_task(watch_empty_room())


async def on_session_end(ctx: agents.JobContext) -> None:
    logger.info("Session ending for room %s", ctx.room.name)
    state = _sessions.pop(ctx.room.name, None) or {}

    audio_egress_id = state.get("audio_egress_id")
    video_egress_id = state.get("video_egress_id")

    if audio_egress_id:
        await stop_and_poll_egress(ctx.api, audio_egress_id)
    if video_egress_id:
        await stop_and_poll_egress(ctx.api, video_egress_id)

    transcript = []
    session_obj = state.get("session")
    if session_obj is not None:
        for item in session_obj.history.items:
            if item.type == "message" and item.role in ("user", "assistant"):
                text = (item.text_content or "").strip()
                if text:
                    transcript.append({"role": "user" if item.role == "user" else "trainer", "text": text})

    webhook_url = state.get("webhook_url") or f"{WEB_URL}/api/sessions/webhook"
    payload = {
        "session_id": state.get("session_id") or ctx.room.name,
        "room_name": ctx.room.name,
        "audio_url": state.get("audio_url"),
        "audio_s3_key": state.get("audio_s3_key"),
        "video_url": state.get("video_url"),
        "video_s3_key": state.get("video_s3_key"),
        "status": state.get("end_status") or "COMPLETED",
        "participant_identity": state.get("participant_identity"),
        "transcript": transcript,
    }

    await post_completion_webhook(webhook_url, payload)

    try:
        await ctx.api.room.delete_room(api.DeleteRoomRequest(room=ctx.room.name))
        logger.info("Room %s gracefully destroyed", ctx.room.name)
    except Exception as exc:
        logger.debug("Room deletion note: %s", exc)


server = agents.AgentServer()
server.rtc_session(agent_name=AGENT_NAME, on_session_end=on_session_end)(entrypoint)


def main() -> None:
    validate_environment()
    agents.cli.run_app(server)


if __name__ == "__main__":
    main()
