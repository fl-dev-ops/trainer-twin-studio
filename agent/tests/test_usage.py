from __future__ import annotations

from types import SimpleNamespace
from typing import ClassVar

from livekit import rtc
from livekit.agents.metrics import LLMModelUsage, STTModelUsage, TTSModelUsage

import usage as usage_mod
from usage import UsageReporter

STANDARD = rtc.ParticipantKind.PARTICIPANT_KIND_STANDARD
EGRESS = rtc.ParticipantKind.PARTICIPANT_KIND_EGRESS


class FakeHttp:
    """Stands in for aiohttp.ClientSession; records posted payloads."""

    posts: ClassVar[list[dict]] = []
    status = 200

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    def post(self, url, json, headers):
        FakeHttp.posts.append({"url": url, "json": json, "headers": headers})
        return _Resp(FakeHttp.status)


class _Resp:
    def __init__(self, status):
        self.status = status

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def text(self):
        return "nope"


def _reporter(monkeypatch) -> UsageReporter:
    FakeHttp.posts = []
    FakeHttp.status = 200
    monkeypatch.setattr(usage_mod.aiohttp, "ClientSession", FakeHttp)
    return UsageReporter(session_id="s1", stream_id="job1", url="http://web/api/internal/usage", secret="sek")


def _session_usage(stt: float, chars: int, tts: float):
    return SimpleNamespace(
        model_usage=[
            STTModelUsage(provider="Deepgram", model="flux-general-en", audio_duration=stt),
            TTSModelUsage(provider="Sarvam", model="bulbul:v3", characters_count=chars, audio_duration=tts),
            LLMModelUsage(provider="chat.trainertwin.com", model="trainertwin-runtime", input_tokens=999),
        ]
    )


def _totals(post) -> dict:
    return {(t["provider"], t["model"], t["metric"]): t["value"] for t in post["json"]["totals"]}


async def test_posts_cumulative_snapshot_without_llm_tokens(monkeypatch):
    rep = _reporter(monkeypatch)
    rep.on_session_usage(_session_usage(6.5, 120, 4.0))
    assert await rep.flush() is True
    [post] = FakeHttp.posts
    assert post["headers"] == {"Authorization": "Bearer sek"}
    assert post["json"]["kind"] == "snapshot" and post["json"]["seq"] == 1
    assert post["json"]["sessionId"] == "s1" and post["json"]["streamId"] == "job1"
    assert _totals(post) == {
        ("Deepgram", "flux-general-en", "stt_seconds"): 6.5,
        ("Sarvam", "bulbul:v3", "tts_characters"): 120,
        ("Sarvam", "bulbul:v3", "tts_seconds"): 4.0,
    }


async def test_unchanged_totals_are_not_reposted_and_failures_retry(monkeypatch):
    rep = _reporter(monkeypatch)
    rep.on_session_usage(_session_usage(5, 10, 1))
    await rep.flush()
    await rep.flush()  # nothing changed
    assert len(FakeHttp.posts) == 1

    rep.on_session_usage(_session_usage(9, 10, 1))
    FakeHttp.status = 500
    assert await rep.flush() is False
    FakeHttp.status = 200
    assert await rep.flush() is True  # resent with a new seq, carrying the newer totals
    assert [p["json"]["seq"] for p in FakeHttp.posts] == [1, 2, 3]
    assert _totals(FakeHttp.posts[-1])[("Deepgram", "flux-general-en", "stt_seconds")] == 9


async def test_vision_tokens_accumulate(monkeypatch):
    rep = _reporter(monkeypatch)
    u = SimpleNamespace(prompt_tokens=1000, completion_tokens=50, prompt_cached_tokens=0)
    rep.add_llm_usage("openrouter", "openai/gpt-5.5", u)
    rep.add_llm_usage("openrouter", "openai/gpt-5.5", u)
    await rep.flush()
    totals = _totals(FakeHttp.posts[0])
    assert totals[("openrouter", "openai/gpt-5.5", "input_tokens")] == 2000
    assert totals[("openrouter", "openai/gpt-5.5", "output_tokens")] == 100
    assert ("openrouter", "openai/gpt-5.5", "cache_read_tokens") not in totals  # zero values dropped


async def test_conversation_clock_counts_only_learners(monkeypatch):
    clock = [100.0]
    monkeypatch.setattr(usage_mod.time, "monotonic", lambda: clock[0])
    rep = _reporter(monkeypatch)
    room = SimpleNamespace(remote_participants={"rec": SimpleNamespace(kind=EGRESS)})
    rep.participants_changed(room)
    clock[0] = 110.0
    assert rep.connected_seconds() == 0  # only the recorder is present

    room.remote_participants["learner"] = SimpleNamespace(kind=STANDARD)
    rep.participants_changed(room)
    clock[0] = 140.0
    del room.remote_participants["learner"]
    rep.participants_changed(room)  # learner left after 30s
    clock[0] = 200.0
    assert rep.connected_seconds() == 30

    await rep.close(final_usage=_session_usage(25, 300, 20))
    totals = _totals(FakeHttp.posts[-1])
    assert totals[("livekit", "room", "connected_seconds")] == 30
    assert totals[("Deepgram", "flux-general-en", "stt_seconds")] == 25
