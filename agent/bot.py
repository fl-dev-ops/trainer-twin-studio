"""TrainerTwin voice agent.

Pipecat pipeline: STT → utterance collector → TTS. The interview brain is the
POC Runtime (analyze → deterministic policy → persona render), one call per
completed learner utterance, spoken via Sarvam TTS.

Run: uv run bot.py -t webrtc   (then connect from the studio's /talk page)
"""

import asyncio
from datetime import datetime
import os
from pathlib import Path
import sys
import uuid

from dotenv import load_dotenv
from loguru import logger
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    InputAudioRawFrame,
    InterruptionFrame,
    TTSSpeakFrame,
    TranscriptionFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.audio.audio_buffer_processor import AudioBufferProcessor
from pipecat.processors.audio.vad_processor import VADProcessor
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.runner.types import RunnerArguments, SmallWebRTCRunnerArguments
from pipecat.services.sarvam.stt import SarvamSTTService
from pipecat.services.sarvam.tts import SarvamTTSService
from pipecat.transports.base_transport import BaseTransport, TransportParams
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport
from pipecat.workers.runner import WorkerRunner

from interview import InterviewSession, WEB_URL
from recording import pcm_to_wav, upload_recording
# Remote cloned-voice TTS is kept for production; local testing uses Sarvam below.
# from web_tts import WebTTSService
from workspace_bridge import WorkspaceBridge
import httpx

load_dotenv(override=True)


class Tee:
    """Mirror server output to the terminal and one run-specific log file."""

    def __init__(self, terminal, log_file):
        self.terminal = terminal
        self.log_file = log_file

    def write(self, text):
        self.terminal.write(text)
        self.log_file.write(text)
        return len(text)

    def flush(self):
        self.terminal.flush()
        self.log_file.flush()

    def __getattr__(self, name):
        return getattr(self.terminal, name)


def setup_run_log() -> Path:
    log_dir = Path(__file__).parent / "logs"
    log_dir.mkdir(exist_ok=True)
    path = log_dir / f"agent-{datetime.now().strftime('%Y%m%d-%H%M%S')}-{os.getpid()}.log"
    log_file = path.open("a", encoding="utf-8", buffering=1)
    sys.stdout = Tee(sys.stdout, log_file)
    sys.stderr = Tee(sys.stderr, log_file)
    logger.remove()
    logger.add(sys.__stderr__, colorize=True)
    logger.add(path, colorize=False)
    print(f"Run log: {path}")
    return path


class WebRTCAudioOutputFilter(FrameProcessor):
    """Ensures user microphone audio (InputAudioRawFrame) is never looped back to the client WebRTC speaker."""

    async def process_frame(self, frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, InputAudioRawFrame):
            # Dropped so user mic audio is not echoed back to the browser WebRTC audio track
            return
        await self.push_frame(frame, direction)


class UtteranceCollector(FrameProcessor):
    """Buffers final STT text; when the user stops speaking, hands the utterance to a callback.

    Handles interruptions: when the user starts speaking while the bot is speaking,
    it broadcasts an InterruptionFrame to stop TTS audio immediately and cancels any
    in-flight turn processing.
    """

    def __init__(self, on_utterance):
        super().__init__()
        self._buffer: list[str] = []
        self._on_utterance = on_utterance
        self._speaking = False
        self._bot_speaking = False
        self._flush_task: asyncio.Task | None = None
        self._task: asyncio.Task | None = None

    async def process_frame(self, frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if isinstance(frame, TranscriptionFrame) and frame.text.strip():
            self._buffer.append(frame.text.strip())
            if self._bot_speaking or (self._task and not self._task.done()):
                logger.info("User speech confirmed during bot playback: '{}' — broadcasting InterruptionFrame", frame.text.strip())
                if self._task and not self._task.done():
                    self._task.cancel()
                await self.broadcast_interruption()
                self._bot_speaking = False

            if not self._speaking:
                self._schedule_flush(0.4)

        elif isinstance(frame, (UserStartedSpeakingFrame, VADUserStartedSpeakingFrame)):
            self._speaking = True
            if self._flush_task and not self._flush_task.done():
                self._flush_task.cancel()
            else:
                self._buffer.clear()

        elif isinstance(frame, (UserStoppedSpeakingFrame, VADUserStoppedSpeakingFrame)):
            self._speaking = False
            self._schedule_flush(0.4)

        elif isinstance(frame, BotStartedSpeakingFrame):
            self._bot_speaking = True

        elif isinstance(frame, BotStoppedSpeakingFrame):
            self._bot_speaking = False

        elif isinstance(frame, InterruptionFrame):
            self._bot_speaking = False
            if self._task and not self._task.done():
                self._task.cancel()

        await self.push_frame(frame, direction)

    def _schedule_flush(self, delay: float):
        if self._flush_task:
            self._flush_task.cancel()
        self._flush_task = asyncio.create_task(self._flush_after(delay))

    async def _flush_after(self, delay: float):
        await asyncio.sleep(delay)
        utterance = " ".join(self._buffer).strip()
        self._buffer.clear()
        if utterance and (self._task is None or self._task.done()):
            logger.info("Learner: {}", utterance)
            self._task = asyncio.create_task(self._run(utterance))

    async def _run(self, utterance: str):
        try:
            await self._on_utterance(utterance)
        except asyncio.CancelledError:
            logger.info("Turn processing cancelled by interruption")
        except Exception:
            logger.exception("Turn failed")
            await self.push_frame(TTSSpeakFrame("Sorry, something went wrong on my side. Could you repeat that?"))

    async def speak(self, text: str):
        await self.push_frame(TTSSpeakFrame(text))


async def make_stt():
    if os.getenv("ASSEMBLYAI_API_KEY"):
        from pipecat.services.assemblyai.stt import AssemblyAISTTService

        return AssemblyAISTTService(
            api_key=os.environ["ASSEMBLYAI_API_KEY"],
            vad_force_turn_endpoint=False,
            audio_passthrough=True,
            settings=AssemblyAISTTService.Settings(
                model="u3-rt-pro",
                min_turn_silence=100,
                continuous_partials=True,
                interruption_delay=0,
                mode="min_latency",
            ),
        )
    return SarvamSTTService(
        api_key=os.environ["SARVAM_API_KEY"],
        mode="transcribe",
        sample_rate=16000,
        audio_passthrough=True,
        settings=SarvamSTTService.Settings(model="saaras:v3", language="en-IN"),
    )


async def run_bot(transport: BaseTransport, runner_args: RunnerArguments):
    session = InterviewSession()
    workspace = WorkspaceBridge()
    surface_state: dict = {"current": None}
    web: dict = {"session_id": None}

    async def apply_surface(phase_index: int):
        """Open/close the client workspace when the phase's configured surface changes."""
        desired = session.surface_for_phase(phase_index)
        key = desired["action"] if desired else None
        if key == surface_state["current"]:
            return
        try:
            if desired:
                await workspace.command(worker, "surface", {
                    "action": desired["action"],
                    "eventId": uuid.uuid4().hex,
                    "payload": desired["payload"],
                })
                surface_state["current"] = key
            elif surface_state["current"]:
                await workspace.command(worker, "surface", {
                    "action": "close_surface",
                    "eventId": uuid.uuid4().hex,
                    "payload": {},
                })
                surface_state["current"] = None
        except Exception:
            logger.warning("Failed to update session surface")

    async def on_utterance(text: str):
        if not session.started:
            await collector.speak(
                "No interview is running yet. Open the studio's talk page and connect from there, "
                "so I know which persona and agent to use."
            )
            return
        response = await session.step(text)
        await worker.rtvi.send_server_message({
            "type": "interview-state",
            "state": session.snapshot(),
        })
        await apply_surface(session.state.get("phase_index", 0) if session.state else 0)
        await collector.speak(response)
        if session.closed:
            await _end_web_session("completed")
            await worker.rtvi.send_server_message({
                "type": "session-ended",
                "status": "completed",
            })

    async def _end_web_session(status: str):
        if not web["session_id"]:
            return
        # Flush + upload the recording while web["session_id"] is still set.
        try:
            await recorder.stop_recording()
        except Exception:
            logger.exception("Failed to finalize session recording")
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                response = await client.patch(f"{WEB_URL}/api/sessions", json={"id": web["session_id"], "status": status})
                response.raise_for_status()
        except Exception:
            logger.warning("Failed to update web session record")
        web["session_id"] = None

    stt = await make_stt()
    collector = UtteranceCollector(on_utterance)
    tts = SarvamTTSService(
        api_key=os.environ["SARVAM_API_KEY"],
        settings=SarvamTTSService.Settings(
            model=os.getenv("SARVAM_TTS_MODEL", "bulbul:v3"),
            voice=os.getenv("SARVAM_SPEAKER", "rohan"),
            language="en-IN",
        ),
    )
    # Remote cloned-voice TTS (restore for production):
    # tts = WebTTSService(web_url=WEB_URL, voice=os.getenv("AGENT_DEFAULT_VOICE_ID", ""))

    # Records the whole session: user and trainer mixed (mono WAV).
    recorder = AudioBufferProcessor(sample_rate=16000, num_channels=1, auto_start_recording=True)

    @recorder.event_handler("on_audio_data")
    async def on_recording_data(recorder, audio, sample_rate, num_channels):
        if not web["session_id"]:
            return
        try:
            await upload_recording(WEB_URL, web["session_id"], pcm_to_wav(audio, sample_rate, num_channels))
        except Exception:
            logger.exception("Failed to upload session recording")

    # Remote cloned-voice resolution (restore with WebTTSService for production):
    # fallback_voice: dict = {"id": None}
    #
    # async def resolve_voice() -> str:
    #     if override := os.getenv("AGENT_VOICE_ID_OVERRIDE"):
    #         return override
    #     if session.voice_id:
    #         return session.voice_id
    #     if tts.voice:
    #         return tts.voice
    #     if fallback_voice["id"]:
    #         return fallback_voice["id"]
    #     try:
    #         async with httpx.AsyncClient(timeout=10) as client:
    #             response = await client.get(f"{WEB_URL}/api/tts/default-voice")
    #             voice = response.json().get("voice")
    #             if voice:
    #                 fallback_voice["id"] = voice["id"]
    #                 logger.info("No voice assigned; using fallback studio voice '{}'", voice["name"])
    #     except Exception:
    #         logger.warning("Could not look up a fallback voice")
    #     return fallback_voice["id"] or ""

    pipeline = Pipeline([
        transport.input(),
        VADProcessor(vad_analyzer=SileroVADAnalyzer(params=VADParams(stop_secs=0.4, start_secs=0.15))),
        workspace,
        stt,
        collector,
        tts,
        recorder,
        WebRTCAudioOutputFilter(),
        transport.output(),
    ])
    worker = PipelineWorker(
        pipeline,
        params=PipelineParams(enable_metrics=True),
        idle_timeout_secs=runner_args.pipeline_idle_timeout_secs,
    )

    @worker.rtvi.event_handler("on_client_message")
    async def on_client_message(rtvi, msg):
        data = msg.data if isinstance(msg.data, dict) else {}
        if msg.type != "start-interview":
            return
        persona_id = str(data.get("personaId") or "").strip()
        agent_id = str(data.get("agentId") or "").strip()
        context_id = data.get("contextId") or data.get("contextFile")
        if not persona_id or not agent_id:
            await rtvi.send_server_message({"type": "interview-error", "error": "personaId and agentId are required"})
            return
        logger.info("Starting interview: persona={}, agent={}", persona_id, agent_id)

        async def prepare():
            try:
                opening = await session.start(persona_id, agent_id, context_id)
                # Remote cloned-voice TTS (restore for production):
                # tts.voice = await resolve_voice()
                # if not tts.voice:
                #     logger.warning("No TTS voice available — trainer will be silent")
                versions = session.snapshot().get("versions", {})
                try:
                    async with httpx.AsyncClient(timeout=10) as client:
                        response = await client.post(f"{WEB_URL}/api/sessions", json={
                            "personaSlug": persona_id,
                            "personaVersion": versions.get("persona", 1),
                            "agentSlug": agent_id,
                            "agentVersion": versions.get("agent", 1),
                            "domainSlug": session._domain.id if session._domain else "",
                            "domainVersion": versions.get("domain", 1),
                        })
                        response.raise_for_status()
                        web["session_id"] = response.json().get("session", {}).get("id")
                except Exception:
                    logger.warning("Could not register session with the web app")
                if web["session_id"]:
                    await rtvi.send_server_message({"type": "session-started", "sessionId": web["session_id"]})
                await rtvi.send_server_message({"type": "interview-state", "state": session.snapshot()})
                await apply_surface(0)
                logger.info("Trainer opening: {}", opening)
                await collector.speak(opening)
            except Exception as error:
                logger.exception("Failed to start interview")
                await rtvi.send_server_message({"type": "interview-error", "error": str(error)})
                await worker.cancel()

        asyncio.create_task(prepare())

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(transport, client):
        logger.info("Client disconnected")
        workspace.cancel_pending()
        surface_state["current"] = None
        await session.abandon("client_disconnected")
        await _end_web_session("abandoned")
        await worker.cancel()

    runner = WorkerRunner(handle_sigint=runner_args.handle_sigint)
    await runner.add_workers(worker)
    await runner.run()


async def bot(runner_args: RunnerArguments):
    if not isinstance(runner_args, SmallWebRTCRunnerArguments):
        raise ValueError(f"Unsupported transport: {type(runner_args).__name__}")
    transport = SmallWebRTCTransport(
        webrtc_connection=runner_args.webrtc_connection,
        params=TransportParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            vad_analyzer=SileroVADAnalyzer(params=VADParams(stop_secs=0.4, start_secs=0.15)),
        ),
    )
    await run_bot(transport, runner_args)


if __name__ == "__main__":
    from pipecat.runner.run import main

    setup_run_log()
    main()
