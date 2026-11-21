"""Opt-in real voice canary; run with the agent's frozen uv environment.

Fixture (0600): {"purpose":"shared-skills-voice-canary","synthetic":true,
"agent_name":"shared-skills-canary-20261119","sessions":[
{"sessionId":"...","orgId":"...","agentSlug":"...","runtimeToken":"..."}]}

Only isolated synthetic sessions prepared by the local canary may be supplied.
This bypasses activation, so success does not prove business activation gates,
package pinning, S3 persistence, billing, or invitation flows.
"""

from __future__ import annotations

import argparse
import asyncio
import datetime
import json
import os
import stat
import subprocess
import tempfile
import time
import uuid
import wave
from pathlib import Path

from dotenv import load_dotenv
from livekit import api, rtc

AGENT_NAME = "shared-skills-canary-20261119"
TURNS = (
    "This is a synthetic training check. Please explain the first important "
    "idea in this training material in two short sentences.",
    "Thank you. Give me one practical example from the training material, "
    "and explain why it matters in two short sentences.",
)
MAX_ROOM_SECONDS = 165


def private_json(path: Path):
    info = path.stat()
    if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600:
        raise ValueError("Fixture must be a regular private 0600 file")
    if info.st_uid != os.getuid():
        raise ValueError("Fixture must be owned by the current user")
    fixture = json.loads(path.read_text())
    if (
        fixture.get("purpose") != "shared-skills-voice-canary"
        or fixture.get("synthetic") is not True
        or fixture.get("agent_name") != AGENT_NAME
    ):
        raise ValueError("Explicit synthetic canary authorization is required")
    sessions = fixture.get("sessions")
    if not isinstance(sessions, list) or not 1 <= len(sessions) <= 2:
        raise ValueError("Supply one or two isolated synthetic sessions")
    for session in sessions:
        for key in ("sessionId", "orgId", "agentSlug", "runtimeToken"):
            if not isinstance(session.get(key), str) or not session[key].strip():
                raise ValueError(f"Missing fixture field: {key}")
    if len({session["sessionId"] for session in sessions}) != len(sessions):
        raise ValueError("Each room requires a distinct synthetic session")
    return fixture


def speech_files(directory: Path) -> list[Path]:
    files = []
    for index, text in enumerate(TURNS):
        path = directory / f"synthetic-{index}.wav"
        subprocess.run(
            [
                "/usr/bin/say", "-v", "Samantha", "-r", "165",
                "--file-format=WAVE", "--data-format=LEI16@24000",
                "-o", str(path), text,
            ],
            check=True, capture_output=True, timeout=30,
        )
        with wave.open(str(path), "rb") as audio:
            if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate()) != (
                1, 2, 24000
            ):
                raise ValueError("Offline speech must be 24kHz mono signed PCM16")
            if not 1 < audio.getnframes() / 24000 < 25:
                raise ValueError("Synthetic speech duration outside safe bounds")
        files.append(path)
    return files


async def publish_speech(source: rtc.AudioSource, path: Path) -> None:
    with wave.open(str(path), "rb") as audio:
        while data := audio.readframes(480):
            await source.capture_frame(rtc.AudioFrame(data, 24000, 1, len(data) // 2))
    await source.wait_for_playout()
    for _ in range(75):
        await source.capture_frame(rtc.AudioFrame.create(24000, 1, 480))
    await source.wait_for_playout()


async def check_room(lk: api.LiveKitAPI, fixture: dict, speech: list[Path], report: dict):
    room_name = f"shared-skills-canary-room-{uuid.uuid4().hex}"
    identity = f"synthetic-learner-{uuid.uuid4().hex}"
    report.update(
        room=room_name, session_id=fixture["sessionId"],
        connected=False, dispatched=False, agent_joined=False,
        audio_seconds=0.0, nonzero_audio_samples=0,
        transcripts=[], data_packets=[], rpc_calls=[], turns=[], errors=[],
    )
    room = rtc.Room()
    source = rtc.AudioSource(24000, 1)
    tasks: list[asyncio.Task] = []
    streams: list[rtc.AudioStream] = []
    last_audio = 0.0
    agent_joined = asyncio.Event()

    async def receive_audio(track):
        nonlocal last_audio
        stream = rtc.AudioStream(track, sample_rate=24000, num_channels=1)
        streams.append(stream)
        async for event in stream:
            frame = event.frame
            report["audio_seconds"] += frame.duration
            nonzero = sum(abs(sample) > 100 for sample in frame.data)
            report["nonzero_audio_samples"] += nonzero
            if nonzero:
                last_audio = time.monotonic()

    @room.on("track_subscribed")
    def on_track(track, _publication, _participant):
        if track.kind == rtc.TrackKind.KIND_AUDIO:
            tasks.append(asyncio.create_task(receive_audio(track)))

    @room.on("participant_connected")
    def on_participant(participant):
        if participant.kind == rtc.ParticipantKind.PARTICIPANT_KIND_AGENT:
            report["agent_joined"] = True
            agent_joined.set()

    @room.on("transcription_received")
    def on_transcription(segments, participant, _publication):
        for segment in segments:
            if segment.final:
                report["transcripts"].append(
                    dict(
                        source="legacy", identity=participant.identity if participant else "",
                        text=segment.text, at=time.monotonic(),
                    )
                )

    async def read_text(reader, participant_identity):
        try:
            text = await reader.read_all()
            report["transcripts"].append(
                dict(
                    source="text_stream", identity=participant_identity,
                    text=text, attributes=dict(reader.info.attributes),
                    at=time.monotonic(),
                )
            )
        except rtc.StreamError as error:
            report["errors"].append(f"text_stream:{type(error).__name__}")

    def on_text(reader, participant_identity):
        tasks.append(asyncio.create_task(read_text(reader, participant_identity)))

    room.register_text_stream_handler("lk.transcription", on_text)

    @room.on("data_received")
    def on_data(packet):
        report["data_packets"].append(
            dict(topic=packet.topic, text=packet.data.decode(errors="replace")[:10000])
        )

    async def surface(data):
        report["rpc_calls"].append(
            dict(method="workspace.surface", payload=json.loads(data.payload))
        )
        return json.dumps({"status": "ready"})

    async def session_end(data):
        report["rpc_calls"].append(
            dict(method="session.end", payload=json.loads(data.payload))
        )
        return json.dumps({"status": "acknowledged"})

    async def await_reply(since: float, baseline: int, seconds: float):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            for task in tasks:
                if task.done() and not task.cancelled():
                    task.result()
            replies = [
                entry for entry in report["transcripts"]
                if entry["identity"] != identity and entry["at"] >= since
                and len(entry["text"].split()) >= 4
            ]
            if (
                replies and report["nonzero_audio_samples"] > baseline + 2400
                and time.monotonic() - last_audio > 1.5
            ):
                return replies
            await asyncio.sleep(0.2)
        raise TimeoutError("Meaningful agent transcript and audible reply not received")

    shared = {
        key: fixture[key] for key in ("sessionId", "orgId", "agentSlug")
    }
    shared.update(hold_opening=False, ends_at=int(time.time()) + MAX_ROOM_SECONDS)
    if fixture.get("voice"):
        shared["voice"] = fixture["voice"]
    started = time.monotonic()
    try:
        report["stage"] = "create_isolated_room"
        existing = await lk.room.list_rooms(api.ListRoomsRequest(names=[room_name]))
        if existing.rooms:
            raise ValueError("Refusing to reuse an existing room")
        await lk.room.create_room(
            api.CreateRoomRequest(
                name=room_name, metadata=json.dumps(shared), empty_timeout=30,
                departure_timeout=15, max_participants=2,
            )
        )
        token = (
            api.AccessToken()
            .with_identity(identity)
            .with_name("Synthetic voice learner")
            .with_ttl(datetime.timedelta(seconds=180))
            .with_grants(
                api.VideoGrants(
                    room_join=True, room=room_name,
                    can_publish=True, can_subscribe=True, can_publish_data=True,
                )
            )
            .to_jwt()
        )
        report["stage"] = "connect_learner"
        await room.connect(os.environ["LIVEKIT_URL"], token)
        report["connected"] = True
        room.local_participant.register_rpc_method("workspace.surface", surface)
        room.local_participant.register_rpc_method("session.end", session_end)
        track = rtc.LocalAudioTrack.create_audio_track("synthetic-learner", source)
        await room.local_participant.publish_track(
            track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE)
        )
        report["stage"] = "dispatch_unique_worker"
        await lk.agent_dispatch.create_dispatch(
            api.CreateAgentDispatchRequest(
                room=room_name, agent_name=AGENT_NAME,
                metadata=json.dumps({**shared, "runtimeToken": fixture["runtimeToken"]}),
            )
        )
        report["dispatched"] = True
        report["stage"] = "await_agent"
        await asyncio.wait_for(agent_joined.wait(), timeout=30)
        report["stage"] = "await_opening_transcript_and_audio"
        try:
            await await_reply(started, 0, 35)
            report["opening_received"] = True
        except TimeoutError:
            report["opening_received"] = False
            report["errors"].append("OpeningTranscriptAudioTimeout")
        for index, path in enumerate(speech):
            report["stage"] = f"spoken_turn_{index + 1}"
            since = time.monotonic()
            baseline = report["nonzero_audio_samples"]
            await publish_speech(source, path)
            try:
                replies = await await_reply(since, baseline, 35)
            except TimeoutError:
                replies = []
                report["errors"].append(f"Turn{index + 1}TranscriptAudioTimeout")
            learner = [
                entry for entry in report["transcripts"]
                if entry["identity"] == identity and entry["at"] >= since
                and len(entry["text"].split()) >= 4
            ]
            report["turns"].append(
                dict(
                    index=index + 1, synthetic_text=TURNS[index],
                    stt_observed=bool(learner),
                    agent_reply_observed=bool(replies),
                    reply_audio_samples=report["nonzero_audio_samples"] - baseline,
                )
            )
            if not learner:
                report["errors"].append(f"Turn{index + 1}LearnerSTTMissing")
        report["passed"] = bool(report["opening_received"]) and all(
            turn["stt_observed"] and turn["agent_reply_observed"]
            for turn in report["turns"]
        )
        report["stage"] = "completed"
    finally:
        await room.disconnect()
        for stream in streams:
            await stream.aclose()
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await source.aclose()
        report["elapsed_seconds"] = round(time.monotonic() - started, 2)
        report["checks"] = {
            "livekit_transport": report["connected"] and report["agent_joined"],
            "stt": len(report["turns"]) == 2 and all(
                turn["stt_observed"] for turn in report["turns"]
            ),
            "model_reply": len(report["turns"]) == 2 and all(
                turn["agent_reply_observed"] for turn in report["turns"]
            ),
            "tts_audio": report["nonzero_audio_samples"] > 2400,
            "provider_attribution": "Requires matching worker logs; audio alone is not provider attribution",
        }


async def run(fixture: dict, speech: list[Path], report: dict):
    async with api.LiveKitAPI() as lk:
        for session in fixture["sessions"]:
            result: dict = {}
            report["rooms"].append(result)
            try:
                await asyncio.wait_for(
                    check_room(lk, session, speech, result), timeout=MAX_ROOM_SECONDS
                )
            except Exception as error:
                result["passed"] = False
                result.setdefault("errors", []).append(type(error).__name__)
                if isinstance(error, (TimeoutError, AssertionError, ValueError)):
                    result["failure"] = str(error)
                break


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--metadata-file", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    if not args.apply:
        parser.error("--apply is required for real provider calls")
    fixture = private_json(args.metadata_file)
    load_dotenv(Path(__file__).resolve().parents[1] / ".env", override=False)
    for key in ("LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"):
        if not os.environ.get(key):
            raise ValueError(f"Missing environment key: {key}")
    report = {
        "purpose": "shared-skills-voice-canary", "agent_name": AGENT_NAME,
        "rooms": [],
        "limitations": [
            "Synthetic session setup bypasses business activation and credit gates.",
            "Transport evidence is separate from S3/Chroma/model-provider canaries.",
            "Package pin stability across publish requires parent DB verification.",
            "Client surface RPC acknowledgements do not prove browser rendering.",
        ],
    }
    fd = os.open(args.report, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as output:
        try:
            with tempfile.TemporaryDirectory(prefix="shared-skills-voice-") as directory:
                speech = speech_files(Path(directory))
                asyncio.run(run(fixture, speech, report))
        finally:
            serialized = json.dumps(report, indent=2)
            secrets = [session["runtimeToken"] for session in fixture["sessions"]]
            secrets.extend(
                value for key, value in os.environ.items()
                if any(marker in key for marker in ("SECRET", "TOKEN", "API_KEY"))
                and len(value) >= 8
            )
            for secret in secrets:
                serialized = serialized.replace(secret, "[REDACTED]")
            output.write(serialized + "\n")
    passed = len(report["rooms"]) == len(fixture["sessions"]) and all(
        room.get("passed") for room in report["rooms"]
    )
    print(json.dumps({"passed": passed, "rooms": len(report["rooms"]), "report": str(args.report)}))
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
