import asyncio
import unittest

from pipecat.frames.frames import Frame, TranscriptionFrame, UserStartedSpeakingFrame, UserStoppedSpeakingFrame
from pipecat.processors.frame_processor import FrameDirection

from bot import UtteranceCollector


class RecordingCollector(UtteranceCollector):
    def __init__(self, on_utterance):
        super().__init__(on_utterance)
        self.forwarded = []

    async def push_frame(self, frame, direction=FrameDirection.DOWNSTREAM):
        self.forwarded.append(frame)


class UtteranceCollectorTest(unittest.IsolatedAsyncioTestCase):
    async def test_forwards_frames_and_handles_transcription_after_vad_stop(self):
        utterances = []

        async def record(text):
            utterances.append(text)

        collector = RecordingCollector(record)
        frame = Frame()

        await collector.process_frame(frame, FrameDirection.DOWNSTREAM)
        await collector.process_frame(UserStartedSpeakingFrame(), FrameDirection.DOWNSTREAM)
        await collector.process_frame(UserStoppedSpeakingFrame(), FrameDirection.DOWNSTREAM)
        await collector.process_frame(
            TranscriptionFrame("Hello", "user", "", finalized=True),
            FrameDirection.DOWNSTREAM,
        )
        # user pauses again mid-utterance, then resumes before the flush grace elapses
        await collector.process_frame(UserStartedSpeakingFrame(), FrameDirection.DOWNSTREAM)
        await collector.process_frame(TranscriptionFrame(" world", "user", "", finalized=True), FrameDirection.DOWNSTREAM)
        await collector.process_frame(UserStoppedSpeakingFrame(), FrameDirection.DOWNSTREAM)
        await asyncio.sleep(1.0)

        self.assertIn(frame, collector.forwarded)
        # resume within the grace window must merge, not truncate
        self.assertEqual(utterances, ["Hello world"])


class WebTtsServiceTest(unittest.IsolatedAsyncioTestCase):
    async def test_missing_voice_yields_error_frame_without_request(self):
        from pipecat.frames.frames import ErrorFrame
        from web_tts import WebTTSService

        service = WebTTSService(web_url="http://localhost:1", voice="")
        frames = [frame async for frame in service.run_tts("hi", "ctx")]
        self.assertTrue(any(isinstance(frame, ErrorFrame) for frame in frames))


if __name__ == "__main__":
    unittest.main()
