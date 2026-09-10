"""Interview evaluation models and types."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


class AssessmentResult(str, Enum):
    CORRECT = "correct"
    PARTIAL = "partial"
    INCORRECT = "incorrect"
    NOT_ATTEMPTED = "not_attempted"


class CodeResult(str, Enum):
    NOT_APPLICABLE = "not_applicable"
    SUBSTANTIALLY_CORRECT = "substantially_correct"
    PARTIAL = "partial"
    INCORRECT = "incorrect"
    NOT_ATTEMPTED = "not_attempted"


class ClosureRoute(str, Enum):
    ACCEPT = "accept"
    REJECT = "reject"
    MIXED = "mixed"
    FEEDBACK_ONLY = "feedback_only"


class QuestionAssessment(BaseModel):
    question_id: str
    result: AssessmentResult
    is_fundamental: bool
    code_result: CodeResult
    evidence: str = Field(min_length=1)


class InterviewEvaluation(BaseModel):
    confidence: float = Field(ge=0, le=1)
    assessments: list[QuestionAssessment]
    strengths: list[str] = Field(
        min_length=1,
        max_length=3,
        description=(
            "Complete, natural sentences spoken directly to the candidate using "
            "'you' or 'your', each tied to specific interview evidence."
        ),
    )
    gaps: list[str] = Field(
        default_factory=list,
        max_length=3,
        description=(
            "Constructive, complete sentences spoken directly to the candidate "
            "using 'you' or 'your', with a specific missing detail or next step."
        ),
    )
    improvement_direction: str = Field(
        min_length=1,
        description=(
            "One actionable, complete suggestion addressed directly to the "
            "candidate using 'you' or 'your'."
        ),
    )
    experience_calibration: str | None = Field(
        default=None,
        description=(
            "When needed, one complete second-person sentence explaining the "
            "depth expected for the candidate's stated experience."
        ),
    )


@dataclass(frozen=True)
class ClosureDecision:
    route: ClosureRoute
    rating: float | None = None


def enforce_mcq_assessments(
    evaluation: InterviewEvaluation,
    mcq_assessments: dict[str, dict[str, Any]],
) -> None:
    by_id = {
        assessment.question_id: assessment for assessment in evaluation.assessments
    }
    for question_id, deterministic in mcq_assessments.items():
        submitted = deterministic.get("submitted") is True
        if submitted:
            result = (
                AssessmentResult.CORRECT
                if deterministic.get("isCorrect") is True
                else AssessmentResult.INCORRECT
            )
            evidence = (
                "The submitted option matched the stored answer."
                if result is AssessmentResult.CORRECT
                else "The submitted option did not match the stored answer."
            )
        else:
            result = AssessmentResult.NOT_ATTEMPTED
            evidence = "The candidate did not submit an option."
        previous = by_id.get(question_id)
        by_id[question_id] = QuestionAssessment(
            question_id=question_id,
            result=result,
            is_fundamental=(previous.is_fundamental if previous is not None else False),
            code_result=CodeResult.NOT_APPLICABLE,
            evidence=evidence,
        )
    existing_ids = [assessment.question_id for assessment in evaluation.assessments]
    evaluation.assessments = [
        by_id[question_id]
        for question_id in existing_ids
        if question_id in by_id
    ]
    evaluation.assessments.extend(
        assessment
        for question_id, assessment in by_id.items()
        if question_id not in existing_ids
    )
