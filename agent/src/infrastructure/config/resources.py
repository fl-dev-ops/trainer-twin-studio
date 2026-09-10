"""Runtime resources: pre-warm profiles, prompts, turn detector."""

from __future__ import annotations

import logging
from collections.abc import MutableMapping
from pathlib import Path
from typing import Any

from livekit.agents import JobProcess
from livekit.agents.inference import TurnDetector

from domains.interview.runtime import (
    InterviewCatalog,
    InterviewConfigError,
    load_interview_catalog,
)
from domains.recording.config import RecordingConfig, build_recording_config
from infrastructure.config.profiles import AgentProfile, load_profile_catalog
from infrastructure.prompt.loader import load_prompt

logger = logging.getLogger(__name__)

USERDATA_TURN_DETECTOR = "turn_detector"
USERDATA_PROFILE_CATALOG = "profile_catalog"
USERDATA_INTERVIEW_CATALOG = "interview_catalog"
USERDATA_RECORDING_CONFIG = "recording_config"


def prewarm_runtime_resources(
    proc: JobProcess,
    *,
    profile_config_path: Path,
    interview_catalog_path: Path,
) -> None:
    userdata = proc.userdata

    try:
        userdata[USERDATA_TURN_DETECTOR] = TurnDetector(version="v1-mini")
    except RuntimeError as e:
        logger.info("Turn detector prewarm deferred until job context: %s", e)

    profile_catalog = load_profile_catalog(profile_config_path)
    interview_catalog = load_interview_catalog(interview_catalog_path)
    for profile in profile_catalog.values():
        default = profile.default_interview
        if default is None:
            continue
        try:
            interview_catalog.require(default.type, default.version)
        except InterviewConfigError as error:
            raise InterviewConfigError(
                f"agents.{profile.id}.default_interview is not registered: {error}"
            ) from error

    userdata[USERDATA_PROFILE_CATALOG] = profile_catalog
    userdata[USERDATA_INTERVIEW_CATALOG] = interview_catalog
    userdata[USERDATA_RECORDING_CONFIG] = build_recording_config()

    for profile in profile_catalog.values():
        try:
            load_prompt(profile.prompt_url)
        except Exception as e:
            logger.warning(
                "Failed to prewarm prompt for agent_id=%s: %s",
                profile.id,
                e,
            )

    for definition in interview_catalog.definitions.values():
        prompt_urls = (
            tuple(
                definition.prompt_url.replace("{round}", round_policy.id.value)
                for round_policy in definition.rounds
            )
            if "{round}" in definition.prompt_url
            else (definition.prompt_url,)
        )
        for prompt_url in prompt_urls:
            try:
                load_prompt(prompt_url)
            except Exception as e:
                logger.warning(
                    "Failed to prewarm interview prompt for type=%s version=%s "
                    "prompt_url=%s: %s",
                    definition.type.value,
                    definition.version,
                    prompt_url,
                    e,
                )

    logger.info(
        "Runtime resources prewarmed: profiles=%s interviews=%s",
        sorted(profile_catalog.keys()),
        sorted(
            f"{interview_type.value}/{version}"
            for interview_type, version in interview_catalog.definitions
        ),
    )


def get_profile_catalog(
    userdata: MutableMapping[str, Any],
    *,
    fallback_path: Path,
) -> dict[AgentProfile]:
    catalog = userdata.get(USERDATA_PROFILE_CATALOG)
    if isinstance(catalog, dict):
        return catalog
    catalog = load_profile_catalog(fallback_path)
    userdata[USERDATA_PROFILE_CATALOG] = catalog
    return catalog


def get_recording_config(userdata: MutableMapping[str, Any]) -> RecordingConfig:
    config = userdata.get(USERDATA_RECORDING_CONFIG)
    if isinstance(config, RecordingConfig):
        return config
    config = build_recording_config()
    userdata[USERDATA_RECORDING_CONFIG] = config
    return config


def get_interview_catalog(
    userdata: MutableMapping[str, Any],
    *,
    fallback_path: Path,
) -> InterviewCatalog:
    catalog = userdata.get(USERDATA_INTERVIEW_CATALOG)
    if isinstance(catalog, InterviewCatalog):
        return catalog
    catalog = load_interview_catalog(fallback_path)
    userdata[USERDATA_INTERVIEW_CATALOG] = catalog
    return catalog


def get_prewarmed_turn_detector(userdata: MutableMapping[str, Any]) -> Any | None:
    return userdata.get(USERDATA_TURN_DETECTOR)


def get_or_create_turn_detector(userdata: MutableMapping[str, Any]) -> Any:
    turn_detector = userdata.get(USERDATA_TURN_DETECTOR)
    if turn_detector is None:
        turn_detector = TurnDetector(version="v1-mini")
        userdata[USERDATA_TURN_DETECTOR] = turn_detector
    return turn_detector
