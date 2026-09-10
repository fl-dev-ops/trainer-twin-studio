from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from domains.interview.questions.store import QuestionStore
from tools.interview.start_question import build_start_question_tool
from tools.interview.whiteboard_highlight import build_whiteboard_highlight_tools


@pytest.mark.asyncio
async def test_start_question_tool_publishes_and_speaks_once() -> None:
    published: list[dict[str, object]] = []
    started: list[dict[str, object]] = []
    spoken: list[str] = []

    class FakeLocalParticipant:
        async def publish_data(self, payload: bytes, *, reliable: bool) -> None:
            assert reliable is True
            published.append(json.loads(payload))

    class FakeSession:
        options = SimpleNamespace(
            turn_handling={"user_turn_limit": {"max_duration": 180}}
        )

        async def say(self, text: str) -> None:
            spoken.append(text)

    async def on_question_started(question: dict[str, object]) -> None:
        started.append(question)

    question_store = QuestionStore()
    question_store.load(
        [
            {
                "id": "q1",
                "text": "Explain the event loop.",
                "spokenText": "Explain the event loop.",
                "questionType": "verbal",
                "responseMode": "verbal",
                "surface": "verbal",
                "answerMode": "verbal",
            }
        ]
    )
    room = SimpleNamespace(local_participant=FakeLocalParticipant())
    start_question = build_start_question_tool(
        room=room,
        question_store=question_store,
        on_question_started=on_question_started,
    )

    result = await start_question._func(
        SimpleNamespace(session=FakeSession()),
        "q1",
    )

    assert result is None
    assert spoken == ["Explain the event loop."]
    assert started[0]["id"] == "q1"
    assert published[0]["type"] == "interview_question_started"


def test_interviewer_prompt_does_not_repeat_tool_spoken_question() -> None:
    prompt = Path(__file__).parents[1] / "prompts/interview/v1/mock_interview.md"
    text = prompt.read_text(encoding="utf-8")

    assert "use `start_question` with its id as a silent tool action" in text
    assert "speaks the complete TTS-safe question exactly once" in text
    assert "Never ask a planned question in your own words" in text


@pytest.mark.asyncio
async def test_whiteboard_tools_read_assessment_then_highlight_component() -> None:
    rpc_calls: list[dict[str, object]] = []

    async def read_assessment() -> dict[str, object]:
        return {
            "questionId": "q1",
            "drawingSummary": {"components": ["API Gateway"]},
            "visualEvaluation": {"gaps": ["No failure path is shown"]},
        }

    class FakeLocalParticipant:
        async def perform_rpc(self, **kwargs: object) -> str:
            rpc_calls.append(kwargs)
            return json.dumps({"ok": True, "componentLabel": "API Gateway"})

    read_tool, highlight_tool = build_whiteboard_highlight_tools(
        room=SimpleNamespace(local_participant=FakeLocalParticipant()),
        participant_identity="candidate-1",
        read_assessment=read_assessment,
    )

    assessment = await read_tool._func(SimpleNamespace())
    highlighted = await highlight_tool._func(SimpleNamespace(), "API Gateway")

    assert assessment["status"] == "ok"
    assert highlighted["ok"] is True
    assert rpc_calls[0]["method"] == "workspace.whiteboard"
    assert json.loads(str(rpc_calls[0]["payload"])) == {
        "action": "highlight_component",
        "payload": {"componentLabel": "API Gateway"},
    }
