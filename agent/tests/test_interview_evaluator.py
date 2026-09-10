from __future__ import annotations

from pathlib import Path

import pytest
from livekit.agents import llm

from domains.interview.evaluation.evaluator import (
    EVALUATOR_ENDING_MESSAGE,
    EVALUATOR_HANDOFF_MESSAGE,
    EVALUATOR_MAX_QUESTION_TURNS,
    ClosureDecision,
    ClosureRoute,
    EvaluatorAgent,
    build_finish_interview_tool,
    decide_closure,
    render_vasanth_closure,
)
from domains.interview.evaluation.models import (
    AssessmentResult,
    CodeResult,
    InterviewEvaluation,
    QuestionAssessment,
)
from domains.interview.evidence.tracker import InterviewEvidenceTracker


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


def _assessment(
    question_id: str,
    result: AssessmentResult,
    *,
    fundamental: bool = False,
    code_result: CodeResult = CodeResult.NOT_APPLICABLE,
) -> QuestionAssessment:
    return QuestionAssessment(
        question_id=question_id,
        result=result,
        is_fundamental=fundamental,
        code_result=code_result,
        evidence=f"Evidence for {question_id}",
    )


def _evaluation(
    assessments: list[QuestionAssessment],
    *,
    strengths: list[str] | None = None,
    gaps: list[str] | None = None,
) -> InterviewEvaluation:
    return InterviewEvaluation(
        confidence=0.9,
        assessments=assessments,
        strengths=strengths
        or ["You explained the concepts clearly and used practical examples."],
        gaps=gaps or [],
        improvement_direction=(
            "You can strengthen future answers by adding one concrete example."
        ),
    )


def test_tracker_maps_turns_and_exact_code_to_the_active_question() -> None:
    tracker = InterviewEvidenceTracker(
        questions=[
            _question("q1"),
            _question("q2", surface="code", answer_mode="surface"),
        ],
        participant_identity="candidate-1",
    )

    tracker.on_question_started(_question("q1"))
    tracker.on_conversation_item(
        llm.ChatMessage(role="assistant", content=["What is a closure?"])
    )
    tracker.on_conversation_item(
        llm.ChatMessage(role="user", content=["A function with lexical scope."])
    )
    tracker.on_conversation_item(
        llm.ChatMessage(
            role="developer",
            content=["two minutes elapsed"],
            extra={"internal_timer": True},
        )
    )
    tracker.on_question_started(_question("q2", surface="code", answer_mode="surface"))

    assert tracker.store_code_answer(
        {
            "questionId": "q2",
            "surface": "code",
            "answerMode": "surface",
            "language": "javascript",
            "code": "const increment = () => 1;",
            "revision": 2,
            "submitted": True,
        },
        participant_identity="candidate-1",
    )

    evidence = tracker.build_evidence()
    assert [turn["role"] for turn in evidence[0]["turns"]] == ["assistant", "user"]
    assert evidence[1]["code_answer"] == {
        "language": "javascript",
        "code": "const increment = () => 1;",
        "revision": 2,
        "submitted": True,
    }


def test_tracker_rejects_unknown_participants_questions_and_stale_code() -> None:
    tracker = InterviewEvidenceTracker(
        questions=[_question("q1", surface="code", answer_mode="surface")],
        participant_identity="candidate-1",
    )
    payload = {
        "questionId": "q1",
        "surface": "code",
        "answerMode": "surface",
        "language": "javascript",
        "code": "let value = 1;",
        "revision": 3,
        "submitted": False,
    }

    assert not tracker.store_code_answer(payload, participant_identity="other")
    assert tracker.store_code_answer(payload, participant_identity="candidate-1")
    assert not tracker.store_code_answer(
        {**payload, "revision": 2},
        participant_identity="candidate-1",
    )
    assert not tracker.store_code_answer(
        {**payload, "questionId": "missing", "revision": 4},
        participant_identity="candidate-1",
    )


def test_strong_candidate_routes_to_accept_at_eighty_percent() -> None:
    questions = [
        _question("q1"),
        _question("q2"),
        _question("q3"),
        _question("q4"),
        _question("q5", surface="code", answer_mode="surface"),
    ]
    tracker = InterviewEvidenceTracker(
        questions=questions,
        participant_identity="candidate-1",
    )
    for question in questions:
        tracker.on_question_started(question)
        tracker.on_conversation_item(
            llm.ChatMessage(role="user", content=[f"Answer for {question['id']}"])
        )
    tracker.store_code_answer(
        {
            "questionId": "q5",
            "surface": "code",
            "answerMode": "surface",
            "language": "javascript",
            "code": "function solution() { return true; }",
            "revision": 1,
            "submitted": True,
        },
        participant_identity="candidate-1",
    )

    evaluation = _evaluation(
        [
            _assessment("q1", AssessmentResult.CORRECT, fundamental=True),
            _assessment("q2", AssessmentResult.CORRECT),
            _assessment("q3", AssessmentResult.CORRECT),
            _assessment("q4", AssessmentResult.CORRECT),
            _assessment(
                "q5",
                AssessmentResult.PARTIAL,
                code_result=CodeResult.SUBSTANTIALLY_CORRECT,
            ),
        ],
        gaps=[
            "You handled most answers well, but one answer could go one level deeper."
        ],
    )

    decision = decide_closure(tracker.build_evidence(), evaluation)
    closure = render_vasanth_closure(decision, evaluation)

    assert decision.route is ClosureRoute.ACCEPT
    assert "I'll just pass on my honest feedback" in closure
    assert "I would definitely select you" in closure
    assert closure.endswith(EVALUATOR_ENDING_MESSAGE)


def test_fundamental_misses_route_to_clear_reject() -> None:
    evidence = [
        {
            **_question(f"q{index}"),
            "turns": [{"role": "user", "text": "An attempted answer"}],
            "code_answer": None,
        }
        for index in range(1, 5)
    ]
    evaluation = _evaluation(
        [
            _assessment("q1", AssessmentResult.INCORRECT, fundamental=True),
            _assessment("q2", AssessmentResult.INCORRECT, fundamental=True),
            _assessment("q3", AssessmentResult.PARTIAL),
            _assessment("q4", AssessmentResult.CORRECT),
        ],
        gaps=[
            "You showed some understanding, but your fundamentals and follow-up "
            "depth are not quite there yet."
        ],
    )

    decision = decide_closure(evidence, evaluation)
    closure = render_vasanth_closure(decision, evaluation)

    assert decision.route is ClosureRoute.REJECT
    assert "I was expecting more" in closure
    assert closure.endswith(EVALUATOR_ENDING_MESSAGE)


def test_mixed_performance_gets_rating_without_hard_verdict() -> None:
    evidence = [
        {
            **_question(f"q{index}"),
            "turns": [{"role": "user", "text": "An attempted answer"}],
            "code_answer": None,
        }
        for index in range(1, 5)
    ]
    evaluation = _evaluation(
        [
            _assessment("q1", AssessmentResult.CORRECT),
            _assessment("q2", AssessmentResult.CORRECT),
            _assessment("q3", AssessmentResult.PARTIAL),
            _assessment("q4", AssessmentResult.INCORRECT),
        ],
        gaps=[
            "You answered some questions well, but your follow-up depth was "
            "inconsistent."
        ],
    )

    decision = decide_closure(evidence, evaluation)
    closure = render_vasanth_closure(decision, evaluation)

    assert decision.route is ClosureRoute.MIXED
    assert decision.rating == 3.0
    assert "out of five" in closure.lower()
    assert "three point five" in closure
    assert "definitely select you" not in closure


def test_incomplete_session_uses_feedback_only_closure() -> None:
    evidence = [
        {
            **_question(f"q{index}"),
            "turns": ([{"role": "user", "text": "One answer"}] if index == 1 else []),
            "code_answer": None,
        }
        for index in range(1, 5)
    ]
    evaluation = _evaluation(
        [
            _assessment("q1", AssessmentResult.CORRECT),
            _assessment("q2", AssessmentResult.NOT_ATTEMPTED),
            _assessment("q3", AssessmentResult.NOT_ATTEMPTED),
            _assessment("q4", AssessmentResult.NOT_ATTEMPTED),
        ]
    )

    decision = decide_closure(evidence, evaluation)
    closure = render_vasanth_closure(decision, evaluation)

    assert decision.route is ClosureRoute.FEEDBACK_ONLY
    assert "I don't want to force a verdict" in closure
    assert "select you" not in closure


def test_evaluator_prompt_keeps_vasanth_closure_contract() -> None:
    prompt = Path(__file__).parents[1] / "prompts/interview/vasanth_evaluator.md"
    text = prompt.read_text(encoding="utf-8")

    assert "I'll just pass on my honest feedback" in text
    assert "if i were interviewing you, i would definitely select you" in text.lower()
    assert "I was expecting more" in text
    assert "three to three and a half" in text
    assert "Candidate-facing feedback language" in text
    assert (
        "You correctly identified the output and explained the variable-hoisting"
        in text
    )
    assert "You explained the event loop clearly" in text
    assert 'using "you" or "your"' in text
    assert EVALUATOR_ENDING_MESSAGE in text
    assert "up to four candidate question turns" in text
    assert "never ends the session" in text


def test_interviewer_prompt_requires_whiteboard_followup_before_handoff() -> None:
    prompt = Path(__file__).parents[1] / "prompts/interview/v1/mock_interview.md"
    text = prompt.read_text(encoding="utf-8")

    assert "silently call `read_whiteboard_assessment`" in text
    assert "Silently call `highlight_whiteboard` with that label" in text
    assert "never call `finish_interview` until the candidate answers" in text
    assert "The mock-interview agent never ends the session itself" in text


def test_finish_interview_tool_reinforces_non_terminal_evaluator_handoff() -> None:
    tracker = InterviewEvidenceTracker(
        questions=[_question("q1")],
        participant_identity="candidate-1",
    )

    tool = build_finish_interview_tool(
        tracker=tracker,
        evaluator_prompt="Evaluate the interview.",
        candidate_context={},
    )
    description = tool.info.description or ""

    assert "Required evaluator handoff" in description
    assert "Continue normal clarification and guidance" in description
    assert "next and only action" in description
    assert "wait for another candidate message" in description
    assert EVALUATOR_HANDOFF_MESSAGE in description
    assert "up to four candidate question turns" in description
    assert "never ends the room" in description


@pytest.mark.asyncio
async def test_evaluator_allows_four_question_turns_without_end_session_tool(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")
    agent = EvaluatorAgent(
        chat_ctx=llm.ChatContext.empty(),
        evaluator_prompt="Evaluate the interview.",
        evaluation_payload={"planned_questions": []},
        mcq_assessments={},
    )

    for turn_number in range(1, EVALUATOR_MAX_QUESTION_TURNS + 1):
        turn_ctx = llm.ChatContext.empty()
        await agent.on_user_turn_completed(
            turn_ctx,
            llm.ChatMessage(role="user", content=["Can you explain the feedback?"]),
        )
        guidance = turn_ctx.items[-1].text_content
        if turn_number == EVALUATOR_MAX_QUESTION_TURNS:
            assert EVALUATOR_ENDING_MESSAGE in guidance
            assert "fourth and final" in guidance

    assert agent.tools == []
    assert "Never end the session" in str(agent.instructions)


def test_closure_addresses_the_candidate_in_natural_language() -> None:
    evaluation = _evaluation(
        [_assessment("q1", AssessmentResult.CORRECT)],
        strengths=[
            "You correctly identified the output and explained variable hoisting "
            "clearly."
        ],
        gaps=[
            "You explained the event loop clearly, but you could add more detail "
            "about the microtask queue."
        ],
    )

    closure = render_vasanth_closure(
        ClosureDecision(ClosureRoute.ACCEPT),
        evaluation,
    )

    assert "You correctly identified the output" in closure
    assert "You explained the event loop clearly" in closure
    assert "The candidate" not in closure
