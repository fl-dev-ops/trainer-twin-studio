"""Load the backend-owned catalog of versioned interview definitions."""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Any

from .models import (
    InterviewAdapters,
    InterviewConfigError,
    InterviewDefinition,
    InterviewModeSchema,
    InterviewType,
    MockInterviewConfig,
    ResumeMasteryConfig,
    ResumeRound,
    ResumeRoundPolicy,
    _as_mapping,
    _parse_type,
    _reject_unknown_keys,
    _required_str,
    parse_mode_config,
)


def _schema(
    *,
    prompt_url: str,
    scripts: dict[str, str],
    adapters: tuple[str, str, str],
    surfaces: tuple[str, ...],
    tools: tuple[str, ...],
    evaluation: str,
    config: dict[str, int],
    round_angles: dict[str, tuple[str, ...]],
    defaults: MockInterviewConfig | ResumeMasteryConfig,
) -> InterviewModeSchema:
    return InterviewModeSchema(
        prompt_url=prompt_url,
        scripts=MappingProxyType(scripts),
        adapters=InterviewAdapters(*adapters),
        surfaces=surfaces,
        tools=tools,
        evaluation=evaluation,
        config=MappingProxyType(config),
        round_angles=MappingProxyType(round_angles),
        defaults=defaults,
    )


MODE_SCHEMAS: Mapping[
    tuple[InterviewType, str], InterviewModeSchema
] = MappingProxyType(
    {
        (InterviewType.MOCK_INTERVIEW, "v1"): _schema(
            prompt_url="prompts/interview/v1/mock_interview.md",
            scripts={
                "initial_reply": (
                    "Follow the Introduction Flow in your system instructions now. "
                    "Use the candidate's actual name, then ask the exact introduction "
                    "question specified there."
                )
            },
            adapters=("mock_interview", "chroma", "question_store"),
            surfaces=("verbal", "code", "whiteboard"),
            tools=(
                "start_question",
                "read_code_range",
                "highlight_code",
                "read_whiteboard_assessment",
                "highlight_whiteboard",
                "build_interview_plan",
                "finish_interview",
            ),
            evaluation="mock_interview",
            config={"max_follow_ups_per_main": 1, "min_whiteboard_follow_ups": 2},
            round_angles={},
            defaults=MockInterviewConfig(),
        ),
        (InterviewType.RESUME_MASTERY, "v1"): _schema(
            prompt_url="prompts/interview/v1/resume/{round}.md",
            scripts={
                "opening": (
                    "Hi {user_name}, let's begin with your resume. I'll ask about your "
                    "projects, impact, and decisions."
                ),
                "round_2_transition": (
                    "Let's move to the impact you claimed and how you measured it."
                ),
                "round_3_transition": (
                    "Now let's test how well you can defend the claims across your resume."
                ),
                "verified_not_found": (
                    "I couldn't locate that claim in the resume preview. Please find and "
                    "point to where it appears."
                ),
                "viewer_recovery": (
                    "The resume preview isn't ready yet. Give it a moment while I "
                    "reconnect it."
                ),
                "cannot_locate": (
                    "That's okay. I'll use another part of your resume."
                ),
                "closing": (
                    "That completes the resume mastery interview. Thank you for walking "
                    "me through your work."
                ),
            },
            adapters=("resume_mastery", "resume_claims", "resume_rounds"),
            surfaces=("resume_pdf",),
            tools=(
                "list_resume_claims",
                "get_resume_claim",
                "start_resume_question",
                "ask_resume_follow_up",
                "present_pending_resume_question",
                "finish_resume_mastery",
            ),
            evaluation="none",
            config={
                "target_duration_minutes": 20,
                "max_question_characters": 500,
                "max_pdf_bytes": 10485760,
                "max_pdf_pages": 10,
                "max_extracted_characters": 50000,
                "max_anchors": 2000,
                "max_rectangles_per_anchor": 8,
                "max_claims": 200,
                "max_anchors_per_claim": 8,
                "max_document_json_bytes": 1048576,
            },
            round_angles={
                "round_1": (
                    "problem_scope",
                    "ownership",
                    "technical_decision",
                    "challenge_outcome",
                ),
                "round_2": (
                    "baseline_measurement",
                    "measurement_method",
                    "attribution_confounders",
                    "business_engineering_impact",
                ),
                "round_3": (
                    "ownership_consistency",
                    "alternative_tradeoff",
                    "failure_scale",
                    "what_would_change",
                ),
            },
            defaults=ResumeMasteryConfig(
                highlighted_sections_per_session=3,
                main_questions_per_section=1,
                max_follow_ups_per_main=1,
            ),
        ),
    }
)


@dataclass(frozen=True)
class InterviewCatalog:
    definitions: Mapping[tuple[InterviewType, str], InterviewDefinition]

    def require(
        self, interview_type: InterviewType, version: str
    ) -> InterviewDefinition:
        definition = self.definitions.get((interview_type, version))
        if definition is None:
            known = sorted(
                f"{known_type.value}/{known_version}"
                for known_type, known_version in self.definitions
            )
            raise InterviewConfigError(
                f"Unknown interview {interview_type.value}/{version}; known: {known}"
            )
        return definition


def _catalog_str(value: Any, field: str) -> str:
    parsed = _required_str(value, field)
    if value != parsed:
        raise InterviewConfigError(f"{field} must not have surrounding whitespace")
    return parsed


def _parse_string_map(value: Any, field: str) -> dict[str, str]:
    raw = _as_mapping(value, field)
    parsed: dict[str, str] = {}
    for key, item in raw.items():
        parsed[key] = _catalog_str(item, f"{field}.{key}")
    return parsed


def _parse_string_list(value: Any, field: str) -> tuple[str, ...]:
    if not isinstance(value, list):
        raise InterviewConfigError(f"{field} must be an array")
    parsed = tuple(
        _catalog_str(item, f"{field}[{index}]")
        for index, item in enumerate(value)
    )
    if len(parsed) != len(set(parsed)):
        raise InterviewConfigError(f"{field} must not contain duplicates")
    return parsed


def _parse_adapters(value: Any) -> InterviewAdapters:
    raw = _as_mapping(value, "interview definition.adapters")
    expected = {"runtime", "question_source", "progress"}
    _reject_unknown_keys(
        raw,
        allowed=expected,
        required=expected,
        field="interview definition.adapters",
    )
    return InterviewAdapters(
        runtime=_catalog_str(
            raw["runtime"], "interview definition.adapters.runtime"
        ),
        question_source=_catalog_str(
            raw["question_source"],
            "interview definition.adapters.question_source",
        ),
        progress=_catalog_str(
            raw["progress"], "interview definition.adapters.progress"
        ),
    )


def _parse_definition_config(value: Any) -> Mapping[str, int]:
    raw = _as_mapping(value, "interview definition.config")
    parsed: dict[str, int] = {}
    for key, item in raw.items():
        if isinstance(item, bool) or not isinstance(item, int) or item < 0:
            raise InterviewConfigError(
                f"interview definition.config.{key} must be a non-negative integer"
            )
        parsed[key] = item
    return MappingProxyType(parsed)


def _parse_round(value: Any, index: int) -> ResumeRoundPolicy:
    field = f"interview definition.rounds[{index}]"
    raw = _as_mapping(value, field)
    _reject_unknown_keys(
        raw,
        allowed={"id", "title", "angles"},
        required={"id", "title", "angles"},
        field=field,
    )
    round_value = _catalog_str(raw["id"], f"{field}.id")
    try:
        round_id = ResumeRound(round_value)
    except ValueError as error:
        raise InterviewConfigError(
            f"{field}.id must be a registered Resume round; got {round_value!r}"
        ) from error

    angles = _parse_string_list(raw["angles"], f"{field}.angles")
    if not angles:
        raise InterviewConfigError(f"{field}.angles must not be empty")
    return ResumeRoundPolicy(
        id=round_id,
        title=_catalog_str(raw["title"], f"{field}.title"),
        angles=angles,
    )


def _require_exact(field: str, actual: object, expected: object) -> None:
    if actual != expected:
        raise InterviewConfigError(
            f"{field} does not match its registered type/version contract"
        )


def parse_interview_definition(value: Any) -> InterviewDefinition:
    raw = _as_mapping(value, "interview definition")
    keys = {
        "type",
        "version",
        "prompt_url",
        "scripts",
        "adapters",
        "surfaces",
        "tools",
        "evaluation",
        "config",
        "rounds",
        "defaults",
    }
    _reject_unknown_keys(
        raw,
        allowed=keys,
        required=keys,
        field="interview definition",
    )

    interview_type = _parse_type(raw["type"], "interview definition.type")
    version = _catalog_str(raw["version"], "interview definition.version")
    _require_exact("interview definition.type", raw["type"], interview_type.value)
    schema = MODE_SCHEMAS.get((interview_type, version))
    if schema is None:
        raise InterviewConfigError(
            f"Interview definition is not registered: {interview_type.value}/{version}"
        )

    scripts = _parse_string_map(raw["scripts"], "interview definition.scripts")
    rounds_value = raw["rounds"]
    if not isinstance(rounds_value, list):
        raise InterviewConfigError("interview definition.rounds must be an array")
    rounds = tuple(_parse_round(item, index) for index, item in enumerate(rounds_value))
    if len(rounds) != len({item.id for item in rounds}):
        raise InterviewConfigError("interview definition.rounds contains duplicate ids")

    defaults = parse_mode_config(interview_type, raw["defaults"])
    definition = InterviewDefinition(
        type=interview_type,
        version=version,
        prompt_url=_catalog_str(
            raw["prompt_url"], "interview definition.prompt_url"
        ),
        scripts=MappingProxyType(scripts),
        adapters=_parse_adapters(raw["adapters"]),
        surfaces=_parse_string_list(raw["surfaces"], "interview definition.surfaces"),
        tools=_parse_string_list(raw["tools"], "interview definition.tools"),
        evaluation=_catalog_str(
            raw["evaluation"], "interview definition.evaluation"
        ),
        config=_parse_definition_config(raw["config"]),
        rounds=rounds,
        defaults=defaults,
    )
    round_angles = tuple((item.id.value, item.angles) for item in rounds)
    expected_round_angles = tuple(schema.round_angles.items())
    _require_exact(
        "interview definition.prompt_url", definition.prompt_url, schema.prompt_url
    )
    _require_exact("interview definition.scripts", definition.scripts, schema.scripts)
    _require_exact(
        "interview definition.adapters", definition.adapters, schema.adapters
    )
    _require_exact("interview definition.surfaces", definition.surfaces, schema.surfaces)
    _require_exact("interview definition.tools", definition.tools, schema.tools)
    _require_exact(
        "interview definition.evaluation", definition.evaluation, schema.evaluation
    )
    _require_exact("interview definition.config", definition.config, schema.config)
    _require_exact("interview definition.rounds", round_angles, expected_round_angles)
    return definition


def load_interview_catalog(path: str | Path) -> InterviewCatalog:
    config_dir = Path(path)
    if not config_dir.is_dir():
        raise InterviewConfigError(f"Interview config directory not found: {config_dir}")

    definitions: dict[tuple[InterviewType, str], InterviewDefinition] = {}
    files = sorted(config_dir.glob("*.json"))
    if not files:
        raise InterviewConfigError(f"No interview definitions found in {config_dir}")

    for config_path in files:
        try:
            payload = json.loads(config_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as error:
            raise InterviewConfigError(
                f"Invalid interview JSON: {config_path}"
            ) from error

        definition = parse_interview_definition(payload)
        expected_name = f"{definition.type.value}.{definition.version}.json"
        if config_path.name != expected_name:
            raise InterviewConfigError(
                f"Interview definition filename must be {expected_name}; got {config_path.name}"
            )
        key = (definition.type, definition.version)
        if key in definitions:
            raise InterviewConfigError(
                f"Duplicate interview definition: {definition.type.value}/{definition.version}"
            )
        definitions[key] = definition

    missing = sorted(
        f"{interview_type.value}/{version}"
        for interview_type, version in set(MODE_SCHEMAS) - set(definitions)
    )
    if missing:
        raise InterviewConfigError(
            f"Interview catalog is missing registered definitions: {missing}"
        )
    return InterviewCatalog(definitions=MappingProxyType(definitions))
