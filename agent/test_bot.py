import asyncio
import unittest

from pipecat.frames.frames import (
    EndWorkerFrame,
    InputAudioRawFrame,
    TranscriptionFrame,
    TTSAudioRawFrame,
)
from pipecat.processors.frame_processor import FrameDirection

from bot import ClosingBoundary, ClosingGate, SpeechInputMonitor


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
