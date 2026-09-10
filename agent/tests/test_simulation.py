from __future__ import annotations

import asyncio

import pytest
from livekit.agents import llm

from domains.interview.evidence.tracker import InterviewEvidenceTracker
from services.simulation import (
    install_answer_submit_shim,
    merge_simulation_userdata,
    simulate_submit_active_question,
)


class _FakeSimulationContext:
    def __init__(self, userdata: dict[str, object]) -> None:
        self._userdata = userdata

    def userdata(self) -> dict[str, object]:
        return self._userdata


def test_merge_simulation_userdata_is_inert_without_simulation() -> None:
    metadata = {"agent_id": "mock_interview"}
    assert merge_simulation_userdata(None, metadata) is metadata


def test_merge_simulation_userdata_overlays_scenario_payload() -> None:
    metadata = {"agent_id": "mock_interview"}
    merged = merge_simulation_userdata(
        _FakeSimulationContext({"agent_id": "mock_interview_v4", "user_name": "Surya"}),
        metadata,
    )
    assert merged["agent_id"] == "mock_interview_v4"
    assert merged["user_name"] == "Surya"
    assert metadata["agent_id"] == "mock_interview"


def _question(
    question_id: str,
    *,
    surface: str = "verbal",
    answer_mode: str = "verbal",
) -> dict[str, str]:
    return {
        "id": question_id,
        "text": f"Question {question_id}",
        "surface": surface,
        "answerMode": answer_mode,
        "language": "javascript",
    }


def _mcq_question() -> dict[str, object]:
    return {
        "id": "q-mcq",
        "text": "Pick one",
        "surface": "choice",
        "answerMode": "surface",
        "questionType": "mcq",
        "language": "javascript",
        "options": ["On every render", "Only on mount"],
        "answer": {
            "correctOption": "Only on mount",
            "explanation": "Empty dependency array.",
        },
    }


async def _immediate(value: object) -> object:
    return value


@pytest.mark.asyncio
async def test_simulate_submit_active_question_records_written_answers() -> None:
    submitted: list[str] = []
    tracker = InterviewEvidenceTracker(
        questions=[
            _question("q-code", surface="code", answer_mode="surface"),
            _mcq_question(),
            _question("q-wb", surface="whiteboard", answer_mode="surface"),
        ],
        participant_identity="candidate-1",
        on_answer_submitted=lambda question_id: _immediate(submitted.append(question_id)),
    )

    tracker.on_question_started(_question("q-code", surface="code", answer_mode="surface"))
    assert await simulate_submit_active_question(tracker) is True
    evidence = tracker.build_evidence()
    assert evidence[0]["code_answer"]["submitted"] is True
    assert await simulate_submit_active_question(tracker) is False

    tracker.on_question_started(tracker._questions_by_id["q-mcq"])
    assert await simulate_submit_active_question(tracker) is True
    mcq = tracker.build_mcq_assessments()
    assert mcq["q-mcq"]["submitted"] is True
    assert mcq["q-mcq"]["isCorrect"] is True

    tracker.on_question_started(_question("q-wb", surface="whiteboard", answer_mode="surface"))
    assert (
        await simulate_submit_active_question(
            tracker,
            whiteboard_assessment={
                "drawingSummary": {"components": ["Feed Service", "Feed Cache"]},
                "visualEvaluation": {"result": "correct"},
            },
        )
        is True
    )
    assessment = await tracker.active_whiteboard_assessment()
    assert assessment is not None
    assert assessment["questionId"] == "q-wb"
    assert assessment["drawingSummary"]["components"] == ["Feed Service", "Feed Cache"]
    assert tracker.is_final_question_ready() is True

    assert submitted == ["q-code", "q-mcq", "q-wb"]


@pytest.mark.asyncio
async def test_simulate_submit_active_question_ignores_verbal_questions() -> None:
    tracker = InterviewEvidenceTracker(
        questions=[_question("q1")],
        participant_identity="candidate-1",
    )
    tracker.on_question_started(_question("q1"))
    assert await simulate_submit_active_question(tracker) is False
    assert tracker.build_evidence()[0]["code_answer"] is None


class _FakeItem:
    def __init__(self, role: str) -> None:
        self.role = role


class _FakeEvent:
    def __init__(self, item: object) -> None:
        self.item = item


class _FakeSession:
    def __init__(self) -> None:
        self.handler: object | None = None

    def on(self, event: str) -> object:
        assert event == "conversation_item_added"

        def register(handler: object) -> object:
            self.handler = handler
            return handler

        return register


@pytest.mark.asyncio
async def test_install_answer_submit_shim_submits_only_on_user_messages(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[object, object]] = []

    async def _fake_submit(tracker: object, *, whiteboard_assessment: object | None) -> bool:
        calls.append((tracker, whiteboard_assessment))
        return True

    monkeypatch.setattr("services.simulation.shims.simulate_submit_active_question", _fake_submit)

    session = _FakeSession()
    tracker = object()
    install_answer_submit_shim(
        session,
        evidence_tracker=tracker,
        metadata={"simulation": {"whiteboard_assessment": {"drawingSummary": {}}}},
    )
    assert session.handler is not None

    session.handler(_FakeEvent(_FakeItem("assistant")))
    session.handler(_FakeEvent(_FakeItem("developer")))
    await asyncio.sleep(0.01)
    assert calls == []

    session.handler(_FakeEvent(_FakeItem("user")))
    await asyncio.sleep(0.01)
    assert len(calls) == 1
    submitted_tracker, whiteboard_assessment = calls[0]
    assert submitted_tracker is tracker
    assert whiteboard_assessment == {"drawingSummary": {}}


@pytest.mark.asyncio
async def test_shim_passes_no_whiteboard_assessment_when_unset(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[object] = []

    async def _fake_submit(tracker: object, *, whiteboard_assessment: object | None) -> bool:
        calls.append(whiteboard_assessment)
        return True

    monkeypatch.setattr("services.simulation.shims.simulate_submit_active_question", _fake_submit)

    session = _FakeSession()
    install_answer_submit_shim(
        session,
        evidence_tracker=object(),
        metadata={},
    )
    assert session.handler is not None
    session.handler(_FakeEvent(_FakeItem("user")))
    await asyncio.sleep(0.01)
    assert calls == [None]
