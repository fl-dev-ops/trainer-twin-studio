import asyncio

from screen_feedback import runtime as runtime_module
from screen_feedback.models import (
    ScreenFeedbackDecision,
    ScreenFeedbackTrigger,
    ScreenSnapshot,
)


class FakeParticipant:
    def __init__(self) -> None:
        self.publish_started = asyncio.Event()
        self.finish_publish = asyncio.Event()
        self.payloads: list[bytes] = []

    async def publish_data(self, payload: bytes, **_kwargs) -> None:
        self.payloads.append(payload)
        self.publish_started.set()
        await self.finish_publish.wait()


class FakeRoom:
    name = "test-room"

    def __init__(self) -> None:
        self.local_participant = FakeParticipant()
        self.remote_participants = {}


class FakeAnalyzer:
    def trigger(self, *_args, **_kwargs):
        return ScreenFeedbackTrigger.DEVIATION

    async def analyze(self, *_args, **_kwargs):
        return ScreenFeedbackDecision(
            should_speak=True,
            confidence=1,
            feedback="Check the highlighted line.",
            reason="test",
            highlight_from_line=1,
            highlight_to_line=1,
        )

    def should_speak(self, *_args, **_kwargs):
        return True


class FakeSession:
    def __init__(self) -> None:
        self.say_calls: list[str] = []

    def say(self, text: str, **_kwargs) -> None:
        self.say_calls.append(text)


async def test_does_not_speak_stale_feedback_after_question_changes(monkeypatch) -> None:
    room = FakeRoom()
    notes: list[str] = []

    async def note_sink(note: str) -> None:
        notes.append(note)

    monkeypatch.setattr(runtime_module, "ScreenFeedbackAnalyzer", FakeAnalyzer)
    runtime = runtime_module.ScreenFeedbackRuntime(
        room=room,
        participant_identity="learner",
        note_sink=note_sink,
    )
    runtime._analyzer = FakeAnalyzer()
    runtime._session = FakeSession()
    runtime._surface_visible = True
    runtime._surface = "code"
    runtime._revision = 1
    runtime._question = {
        "id": "q1",
        "text": "Old code question",
        "questionType": "coding",
        "surface": "code",
    }
    snapshot = ScreenSnapshot(
        frame=object(),
        question=dict(runtime._question),
        revision=1,
        inactive_seconds=1,
    )
    runtime._snapshot = lambda: snapshot
    runtime._can_evaluate = lambda: True

    evaluation = asyncio.create_task(runtime._evaluate())
    await room.local_participant.publish_started.wait()
    runtime._question = {
        "id": "q2",
        "text": "New verbal question",
        "questionType": "verbal",
        "surface": "verbal",
    }
    room.local_participant.finish_publish.set()
    await evaluation

    assert b'"questionId": "q1"' in room.local_participant.payloads[0]
    assert runtime._session.say_calls == []
    assert notes == []
