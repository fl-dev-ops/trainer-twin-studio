import asyncio
import unittest
from unittest.mock import AsyncMock

from pipecat.frames.frames import (
    EndWorkerFrame,
    InputAudioRawFrame,
    InterruptionFrame,
    LLMContextFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
    TranscriptionFrame,
    TTSAudioRawFrame,
)
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.frame_processor import FrameDirection

from bot import ClosingBoundary, ClosingGate, InterviewBrainProcessor, SpeechInputMonitor, _latest_user_text


class RecordingGate(ClosingGate):
    def __init__(self, on_complete):
        super().__init__(on_complete)
        self.forwarded = []

    async def push_frame(self, frame, direction=FrameDirection.DOWNSTREAM):
        self.forwarded.append((frame, direction))


class ClosingGateTest(unittest.IsolatedAsyncioTestCase):
    async def test_closes_only_after_ordered_audio_boundary(self):
        delivered = []

        async def complete(value):
            delivered.append(value)

        gate = RecordingGate(complete)
        await gate.process_frame(ClosingBoundary(beginning=True), FrameDirection.DOWNSTREAM)
        audio = TTSAudioRawFrame(b"\0" * 320, 16000, 1)
        await gate.process_frame(audio, FrameDirection.DOWNSTREAM)
        await gate.process_frame(ClosingBoundary(beginning=False), FrameDirection.DOWNSTREAM)

        self.assertEqual(delivered, [True])
        self.assertIn((audio, FrameDirection.DOWNSTREAM), gate.forwarded)
        self.assertTrue(any(isinstance(frame, EndWorkerFrame) and direction == FrameDirection.UPSTREAM
                            for frame, direction in gate.forwarded))


class RecordingSpeechInputMonitor(SpeechInputMonitor):
    def __init__(self):
        super().__init__()
        self.forwarded = []

    async def push_frame(self, frame, direction=FrameDirection.DOWNSTREAM):
        self.forwarded.append(frame)


class SpeechInputMonitorTest(unittest.IsolatedAsyncioTestCase):
    async def test_finalizes_sarvam_transcript_without_changing_text(self):
        monitor = RecordingSpeechInputMonitor()
        audio = InputAudioRawFrame(b"\0" * 640, 16000, 1)
        transcript = TranscriptionFrame("hello", "user", "now")

        await monitor.process_frame(audio, FrameDirection.DOWNSTREAM)
        await monitor.process_frame(transcript, FrameDirection.DOWNSTREAM)

        self.assertTrue(transcript.finalized)
        self.assertEqual(monitor.forwarded, [audio, transcript])


class RecordingBrain(InterviewBrainProcessor):
    def __init__(self, session, **kwargs):
        super().__init__(session, **kwargs)
        self.forwarded = []

    async def push_frame(self, frame, direction=FrameDirection.DOWNSTREAM):
        self.forwarded.append(frame)


class FakeSession:
    def __init__(self):
        self.started = True
        self.closed = False
        self.state = {"phase_index": 0}
        self.step = AsyncMock(return_value="Follow up?")

    def snapshot(self):
        return {"phase_index": 0}


class InterviewBrainProcessorTest(unittest.IsolatedAsyncioTestCase):
    async def test_say_emits_llm_response_frames(self):
        brain = RecordingBrain(FakeSession())
        await brain.say("Welcome.")
        types = [type(frame) for frame in brain.forwarded]
        self.assertEqual(types, [LLMFullResponseStartFrame, LLMTextFrame, LLMFullResponseEndFrame])
        self.assertEqual(brain.forwarded[1].text, "Welcome.")

    async def test_say_closing_wraps_boundaries_and_arms(self):
        armed = []
        brain = RecordingBrain(FakeSession(), on_closing=lambda: armed.append(True))
        await brain.say("We’re done.", closing=True)
        self.assertEqual(armed, [True])
        self.assertTrue(brain.closing)
        self.assertIsInstance(brain.forwarded[0], ClosingBoundary)
        self.assertTrue(brain.forwarded[0].beginning)
        self.assertIsInstance(brain.forwarded[-1], ClosingBoundary)
        self.assertFalse(brain.forwarded[-1].beginning)

    async def test_context_frame_runs_session_step(self):
        session = FakeSession()
        completed = []

        async def on_complete():
            completed.append(True)

        brain = RecordingBrain(session, on_turn_complete=on_complete)
        context = LLMContext()
        context.add_message({"role": "user", "content": "I owned the API gateway."})
        await brain.process_frame(LLMContextFrame(context=context), FrameDirection.DOWNSTREAM)
        await asyncio.wait_for(brain._task, timeout=2)

        session.step.assert_awaited_once_with("I owned the API gateway.")
        self.assertEqual(completed, [True])
        self.assertTrue(any(isinstance(frame, LLMTextFrame) and frame.text == "Follow up?" for frame in brain.forwarded))

    async def test_interruption_cancels_in_flight_turn(self):
        session = FakeSession()
        started = asyncio.Event()
        release = asyncio.Event()

        async def slow_step(text):
            started.set()
            await release.wait()
            return "late"

        session.step = slow_step
        brain = RecordingBrain(session)
        context = LLMContext()
        context.add_message({"role": "user", "content": "hello"})
        await brain.process_frame(LLMContextFrame(context=context), FrameDirection.DOWNSTREAM)
        await started.wait()
        await brain.process_frame(InterruptionFrame(), FrameDirection.DOWNSTREAM)
        await asyncio.sleep(0.05)
        release.set()
        await asyncio.sleep(0.05)
        self.assertFalse(any(isinstance(frame, LLMTextFrame) and frame.text == "late" for frame in brain.forwarded))
        self.assertTrue(any(isinstance(frame, InterruptionFrame) for frame in brain.forwarded))


class LatestUserTextTest(unittest.TestCase):
    def test_reads_latest_user_string(self):
        context = LLMContext()
        context.add_message({"role": "assistant", "content": "Hi"})
        context.add_message({"role": "user", "content": "first"})
        context.add_message({"role": "user", "content": "second"})
        self.assertEqual(_latest_user_text(context), "second")


class WebTtsServiceTest(unittest.IsolatedAsyncioTestCase):
    async def test_missing_voice_yields_error_frame_without_request(self):
        from pipecat.frames.frames import ErrorFrame
        from web_tts import WebTTSService

        service = WebTTSService(web_url="http://localhost:1", voice="")
        frames = [frame async for frame in service.run_tts("hi", "ctx")]
        self.assertTrue(any(isinstance(frame, ErrorFrame) for frame in frames))


class TranscriptRoleMappingTest(unittest.TestCase):
    def test_learner_role_mapped_to_user(self):
        messages = [
            {"role": "trainer", "text": "What is hoisting?"},
            {"role": "learner", "text": "Variables declared with var are moved to top."},
        ]
        mapped = [
            {"role": "user" if m.get("role") == "learner" else m.get("role"), "text": m.get("text", "")}
            for m in messages
        ]
        self.assertEqual(mapped, [
            {"role": "trainer", "text": "What is hoisting?"},
            {"role": "user", "text": "Variables declared with var are moved to top."},
        ])


if __name__ == "__main__":
    unittest.main()
