from __future__ import annotations

import asyncio

import pytest
from livekit.agents import tts

from tts.sentence_flush import IdleFlushSentenceTokenizer, with_idle_sentence_flush
from tts.voxcpm2 import VoxCPM2TTS


async def _drain(stream, wait_s: float) -> list[str]:
    tokens: list[str] = []

    async def collect() -> None:
        async for event in stream:
            tokens.append(event.token.strip())

    task = asyncio.create_task(collect())
    await asyncio.sleep(wait_s)
    task.cancel()
    return tokens


@pytest.mark.asyncio
async def test_finished_sentence_is_released_when_text_pauses():
    stream = IdleFlushSentenceTokenizer(idle_flush_s=0.05).stream()
    stream.push_text("Walk me through how you designed the payments retry flow?")

    assert await _drain(stream, 0.15) == ["Walk me through how you designed the payments retry flow?"]


@pytest.mark.asyncio
async def test_mid_sentence_pause_keeps_waiting():
    stream = IdleFlushSentenceTokenizer(idle_flush_s=0.05).stream()
    stream.push_text("Walk me through how you designed")

    assert await _drain(stream, 0.15) == []
    stream.push_text(" the payments retry flow?")
    assert await _drain(stream, 0.15) == ["Walk me through how you designed the payments retry flow?"]


@pytest.mark.asyncio
async def test_continuous_text_still_splits_by_sentence():
    stream = IdleFlushSentenceTokenizer(idle_flush_s=0.05).stream()
    stream.push_text("That makes sense, thanks for explaining it. ")
    stream.push_text("Now tell me how you measured the impact of that change?")
    stream.end_input()

    tokens = [event.token.strip() async for event in stream]
    assert tokens == [
        "That makes sense, thanks for explaining it.",
        "Now tell me how you measured the impact of that change?",
    ]


@pytest.mark.asyncio
async def test_idle_release_does_not_repeat_text_at_end_of_stream():
    stream = IdleFlushSentenceTokenizer(idle_flush_s=0.05).stream()
    stream.push_text("What did you own in that project?")
    released = await _drain(stream, 0.15)
    stream.end_input()

    rest = [event.token.strip() async for event in stream]
    assert released == ["What did you own in that project?"]
    assert [token for token in rest if token] == []


def test_wraps_only_non_streaming_tts():
    voxcpm = VoxCPM2TTS(endpoint="http://tts.local/api/tts/speech")
    wrapped = with_idle_sentence_flush(voxcpm)
    assert isinstance(wrapped, tts.StreamAdapter)
    assert isinstance(wrapped._sentence_tokenizer, IdleFlushSentenceTokenizer)
    assert with_idle_sentence_flush(wrapped) is wrapped
