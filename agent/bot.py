"""TrainerTwin voice agent.

Pipecat pipeline: VAD → STT → SmartTurn → utterance collector → TTS. The interview brain is the
spec-driven Runtime (analyze → deterministic policy → persona render), using
Studio Persona/Agent/Domain settings, spoken via Sarvam TTS.

Run: uv run bot.py -t webrtc   (then connect from the studio's /talk page)
"""

import asyncio
from datetime import datetime
from dataclasses import dataclass
import os
from pathlib import Path
import sys
import uuid

from dotenv import load_dotenv
from loguru import logger
from pipecat.audio.turn.smart_turn.local_smart_turn_v3 import LocalSmartTurnAnalyzerV3
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    DataFrame,
    EndWorkerFrame,
    ErrorFrame,
    TTSAudioRawFrame,
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
from pipecat.turns.user_stop import TurnAnalyzerUserTurnStopStrategy
from pipecat.turns.user_turn_processor import UserTurnProcessor
from pipecat.turns.user_turn_strategies import UserTurnStrategies
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


@dataclass
class ClosingBoundary(DataFrame):
    beginning: bool


class ClosingGate(FrameProcessor):
    """Ordered TTS markers, observed after transport drain; never a stale speech-stop flag."""

    def __init__(self, on_complete):
        super().__init__()
        self.on_complete = on_complete
        self.active = False
        self.audio = False
        self.done = False
        self.timer = None

    def arm(self):
        if self.timer is None:
            self.timer = asyncio.create_task(self._timeout())

    async def _timeout(self):
        await asyncio.sleep(30)
        await self.complete(False)

    async def complete(self, delivered):
        if self.done:
            return
        self.done = True
        if self.timer and self.timer is not asyncio.current_task():
            self.timer.cancel()
        try:
            await self.on_complete(delivered)
        finally:
            await self.push_frame(EndWorkerFrame(), FrameDirection.UPSTREAM)

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if direction == FrameDirection.DOWNSTREAM:
            if isinstance(frame, (InterruptionFrame, ErrorFrame)) and self.active:
                self.active = False
            if isinstance(frame, TTSAudioRawFrame) and self.active and frame.audio:
                self.audio = True
            if isinstance(frame, ClosingBoundary):
                if frame.beginning:
                    self.active, self.audio = True, False
                else:
                    await self.complete(self.active and self.audio)
                return
        await self.push_frame(frame, direction)

    async def cleanup(self):
        if self.timer:
            self.timer.cancel()
            await asyncio.gather(self.timer, return_exceptions=True)
        await super().cleanup()


class SpeechInputMonitor(FrameProcessor):
    """Make the mic→STT boundary observable and normalize Sarvam final results."""

    def __init__(self):
        super().__init__()
        self._seen_audio = False
        self._speech_bytes = 0

    async def process_frame(self, frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if direction == FrameDirection.DOWNSTREAM:
            if isinstance(frame, InputAudioRawFrame):
                if not self._seen_audio:
                    self._seen_audio = True
                    logger.info(
                        "Microphone audio received: {} Hz, {} channel(s), {} bytes/frame",
                        frame.sample_rate, frame.num_channels, len(frame.audio),
                    )
                self._speech_bytes += len(frame.audio)
            elif isinstance(frame, VADUserStartedSpeakingFrame):
                self._speech_bytes = 0
            elif isinstance(frame, VADUserStoppedSpeakingFrame):
                logger.info("VAD pause: {} bytes of microphone audio", self._speech_bytes)
            elif isinstance(frame, TranscriptionFrame) and frame.text.strip():
                # Sarvam's completed WebSocket response currently omits this flag.
                # SmartTurn and the RTVI browser both use it as the final-text signal.
                frame.finalized = True
                logger.info("STT final: {}", frame.text.strip())
            elif isinstance(frame, ErrorFrame):
                logger.error("Speech input error: {}", frame.error)
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
        self.closing = False

    async def process_frame(self, frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if self.closing and isinstance(frame, (TranscriptionFrame, UserStartedSpeakingFrame, UserStoppedSpeakingFrame)):
            return
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

        elif isinstance(frame, UserStartedSpeakingFrame):
            self._speaking = True
            if self._flush_task and not self._flush_task.done():
                self._flush_task.cancel()
            else:
                self._buffer.clear()

        elif isinstance(frame, UserStoppedSpeakingFrame):
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
        elif not utterance:
            logger.warning("SmartTurn ended a user turn, but STT produced no text")

    async def _run(self, utterance: str):
        try:
            await self._on_utterance(utterance)
        except asyncio.CancelledError:
            logger.info("Turn processing cancelled by interruption")
        except Exception:
            logger.exception("Turn failed")
            await self.push_frame(TTSSpeakFrame("Sorry, something went wrong on my side. Could you repeat that?"))

    async def speak(self, text: str, closing: bool = False):
        if closing:
            self.closing = True
            await self.push_frame(ClosingBoundary(beginning=True))
        await self.push_frame(TTSSpeakFrame(text))
        if closing:
            await self.push_frame(ClosingBoundary(beginning=False))

    async def cancel_turn(self):
        for task in (self._task, self._flush_task):
            if task:
                task.cancel()
        await asyncio.gather(*(t for t in (self._task, self._flush_task) if t), return_exceptions=True)

    async def cleanup(self):
        await self.cancel_turn()
        await super().cleanup()


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
        settings=SarvamSTTService.Settings(model="saaras:v3", language="en-IN", vad_signals=False),
    )


async def run_bot(transport: BaseTransport, runner_args: RunnerArguments):
    session = InterviewSession()
    workspace = WorkspaceBridge()
    surface_state: dict = {"current": None}
    web: dict = {"session_id": None, "runtime_token": None}
    starting = False
    prepare_task = None
    end_lock = asyncio.Lock()

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
        if session.closed or starting:
            return
        if not session.started:
            await collector.speak(
                "No interview is running yet. Open the studio's talk page and connect from there, "
                "so I know which persona and agent to use."
            )
            return
        response = await session.step(text)
        if session.closed:
            closing_gate.arm()
        await collector.speak(response, closing=session.closed)
        # A UI error must not trigger an invitation to repeat an already graded answer.
        try:
            await worker.rtvi.send_server_message({"type": "interview-state", "state": session.snapshot()})
            await apply_surface(session.state.get("phase_index", 0))
        except Exception:
            logger.exception("Could not update session UI")

    async def closing_complete(delivered: bool):
        await _end_web_session("completed")
        if not delivered:
            logger.warning("Closing audio was not delivered completely")
        await worker.rtvi.send_server_message({"type": "session-ended", "status": "completed", "closingDelivered": delivered})

    async def _end_web_session(status: str):
        async with end_lock:
            if not web["session_id"]:
                return
            # Serialize completion/disconnect, keeping the ID until successful.
            try:
                await recorder.stop_recording()
                transcript = [
                    {"role": "user" if m.get("role") == "learner" else m.get("role"), "text": m.get("text", "")}
                    for m in getattr(session, "messages", [])
                ]
                async with httpx.AsyncClient(timeout=10) as client:
                    response = await client.patch(
                        f"{WEB_URL}/api/sessions",
                        headers={"Authorization": f"Bearer {web['runtime_token']}"},
                        json={
                            "id": web["session_id"],
                            "status": status,
                            "transcript": transcript,
                            "evidence": session.state.get("coverage", {}),
                        },
                    )
                    response.raise_for_status()
            except Exception:
                logger.exception("Failed to finalize web session; local transcript retained")
                return
            web["session_id"] = None
            web["runtime_token"] = None

    stt = await make_stt()
    speech_monitor = SpeechInputMonitor()
    smart_turn = UserTurnProcessor(
        user_turn_strategies=UserTurnStrategies(
            stop=[TurnAnalyzerUserTurnStopStrategy(turn_analyzer=LocalSmartTurnAnalyzerV3())],
        ),
        user_turn_stop_timeout=5.0,
    )
    collector = UtteranceCollector(on_utterance)
    closing_gate = ClosingGate(closing_complete)
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
            await upload_recording(
                WEB_URL, web["session_id"], web["runtime_token"],
                pcm_to_wav(audio, sample_rate, num_channels),
            )
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
        VADProcessor(vad_analyzer=SileroVADAnalyzer(params=VADParams(stop_secs=0.2, start_secs=0.15))),
        workspace,
        stt,
        speech_monitor,
        smart_turn,
        collector,
        tts,
        recorder,
        WebRTCAudioOutputFilter(),
        transport.output(),
        closing_gate,
    ])
    worker = PipelineWorker(
        pipeline,
        params=PipelineParams(enable_metrics=True),
        idle_timeout_secs=runner_args.pipeline_idle_timeout_secs,
    )

    @worker.event_handler("on_pipeline_error")
    async def on_pipeline_error(worker, frame):
        if collector.closing:
            await closing_gate.complete(False)

    @worker.rtvi.event_handler("on_client_message")
    async def on_client_message(rtvi, msg):
        nonlocal starting, prepare_task
        data = msg.data if isinstance(msg.data, dict) else {}
        if msg.type != "start-interview" or starting or session.started or session.closed:
            return
        session_id = str(data.get("sessionId") or "").strip()
        runtime_token = str(data.get("runtimeToken") or "").strip()
        if not session_id or not runtime_token:
            await rtvi.send_server_message({"type": "interview-error", "error": "sessionId and runtimeToken are required"})
            return
        logger.info("Starting bound interview session {}", session_id)

        starting = True

        async def prepare():
            nonlocal starting
            try:
                opening = await session.start(session_id, runtime_token)
                web["session_id"] = session_id
                web["runtime_token"] = runtime_token
                # Remote cloned-voice TTS (restore for production):
                # tts.voice = await resolve_voice()
                # if not tts.voice:
                #     logger.warning("No TTS voice available — trainer will be silent")
                await rtvi.send_server_message({"type": "session-started", "sessionId": session_id})
                await rtvi.send_server_message({"type": "interview-state", "state": session.snapshot()})
                await apply_surface(0)
                logger.info("Trainer opening: {}", opening)
                await collector.speak(opening)
            except Exception as error:
                logger.exception("Failed to start interview")
                await rtvi.send_server_message({"type": "interview-error", "error": str(error)})
                await worker.cancel()

            finally:
                starting = False

        prepare_task = asyncio.create_task(prepare())

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(transport, client):
        logger.info("Client disconnected")
        workspace.cancel_pending()
        await collector.cancel_turn()
        if prepare_task:
            prepare_task.cancel()
            await asyncio.gather(prepare_task, return_exceptions=True)
        surface_state["current"] = None
        await session.abandon("client_disconnected")
        await _end_web_session("completed" if session.state.get("end_reason") == "completed" else "abandoned")
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
            audio_in_sample_rate=16000,
        ),
    )
    await run_bot(transport, runner_args)


if __name__ == "__main__":
    from pipecat.runner.run import main

    setup_run_log()
    main()
