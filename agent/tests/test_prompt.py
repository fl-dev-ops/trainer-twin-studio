from __future__ import annotations

import io
from pathlib import Path
from infrastructure.config.profiles import load_profile_catalog
from unittest.mock import patch

import pytest

from infrastructure.prompt import (
    build_prompt_context,
    clear_prompt_cache,
    load_prompt,
    render_prompt,
)

CONFIG_PATH = Path(__file__).resolve().parents[1] / "config" / "agents.json"


@pytest.fixture(autouse=True)
def _reset_prompt_cache():
    clear_prompt_cache()
    yield
    clear_prompt_cache()


def test_build_prompt_context_uses_defaults_when_metadata_missing() -> None:
    assert build_prompt_context(None) == {
        "adaptive_plan": "",
        "additional_context": "",
        "interview_plan": "",
        "resume_markdown": "",
        "user_name": "the student",
    }


def test_build_prompt_context_uses_mock_interview_metadata() -> None:
    context = build_prompt_context(
        {
            "user_name": "Ravi",
            "prompt_context": {
                "interview_plan": "1. Introduce yourself",
                "comfortable_language": "hindi",
            },
        }
    )

    assert context["user_name"] == "Ravi"
    assert context["interview_plan"] == "1. Introduce yourself"
    assert context["comfortable_language"] == "hindi"
    assert context["additional_context"] == '{"comfortable_language": "hindi"}'


def test_build_prompt_context_renders_resume_without_duplicating_it() -> None:
    context = build_prompt_context(
        {
            "user_name": "Ravi",
            "prompt_context": {
                "resume_markdown": "# Ravi\n\nStaff engineer at Freshworks.",
                "comfortable_language": "hindi",
            },
        }
    )

    assert context["resume_markdown"] == "# Ravi\n\nStaff engineer at Freshworks."
    assert "Freshworks" not in context["additional_context"]
    assert context["additional_context"] == '{"comfortable_language": "hindi"}'


def test_render_prompt_substitutes_known_keys_and_warns_on_missing() -> None:
    template = "Hello {user_name}. Plan: {interview_plan}. Note: {missing_key}"

    rendered = render_prompt(
        template,
        context={"user_name": "Ravi", "interview_plan": "Ask about projects"},
    )

    assert rendered.startswith("Hello Ravi. Plan: Ask about projects.")
    assert "{missing_key}" not in rendered


def _fake_response(body: bytes, status: int = 200):
    response = io.BytesIO(body)
    response.status = status
    response.getcode = lambda: status
    return response


def test_load_prompt_fetches_url_and_caches() -> None:
    body = b"Talk to {user_name}."

    class _Manager:
        def __init__(self, payload):
            self._payload = payload

        def __enter__(self):
            return self._payload

        def __exit__(self, *args):
            return False

    with patch("infrastructure.prompt.loader.request.urlopen") as mock_urlopen:
        mock_urlopen.return_value = _Manager(_fake_response(body))

        first = load_prompt("https://example.com/p.md")
        second = load_prompt("https://example.com/p.md")

    assert first == "Talk to {user_name}."
    assert first == second
    assert mock_urlopen.call_count == 1


def test_load_prompt_reads_vasanth_prompt() -> None:
    prompt = load_prompt("prompts/interview/v1/mock_interview.md")

    assert "Vasanth" in prompt
    assert "build_interview_plan" in prompt


def test_configured_mock_interview_prompt_loads() -> None:
    catalog = load_profile_catalog(CONFIG_PATH)

    assert load_prompt(catalog["mock_interview"].prompt_url)


def test_load_prompt_raises_on_empty_body() -> None:
    class _Manager:
        def __enter__(self):
            return _fake_response(b"   \n  ")

        def __exit__(self, *args):
            return False

    with patch("infrastructure.prompt.loader.request.urlopen", return_value=_Manager()):
        with pytest.raises(ValueError, match="empty"):
            load_prompt("https://example.com/empty.md")


def test_load_prompt_raises_on_http_error() -> None:
    class _Manager:
        def __enter__(self):
            return _fake_response(b"server down", status=500)

        def __exit__(self, *args):
            return False

    with patch("infrastructure.prompt.loader.request.urlopen", return_value=_Manager()):
        with pytest.raises(RuntimeError, match="HTTP 500"):
            load_prompt("https://example.com/broken.md")
