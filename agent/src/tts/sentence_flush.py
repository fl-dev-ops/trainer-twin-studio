"""Sentence splitting for non-streaming TTS that doesn't hold a finished sentence hostage.

LiveKit sends a sentence to a non-streaming TTS only once the next sentence starts or the LLM
stream ends. The brain can keep its stream open for seconds after the spoken text is complete
(e.g. Eve speaks a resume question, then waits for the highlight and a final silent LLM call),
so the last sentence used to wait for all of that. Here a buffered sentence that already ends
in sentence punctuation is released once no new text has arrived for ``idle_flush_s``.
"""

from __future__ import annotations

import asyncio
import re

from livekit.agents import tokenize, tts
from livekit.agents.tokenize import token_stream
from livekit.agents.tokenize.token_stream import TokenData

DEFAULT_IDLE_FLUSH_S = 0.2
_SENTENCE_END = re.compile(r"[.?!][\"')\]]*\s*$")


class IdleFlushSentenceStream(token_stream.BufferedSentenceStream):
    def __init__(self, *, idle_flush_s: float, **kwargs) -> None:
        super().__init__(**kwargs)
        self._idle_flush_s = idle_flush_s
        self._idle_timer: asyncio.TimerHandle | None = None

    def push_text(self, text: str) -> None:
        super().push_text(text)
        self._cancel_idle_timer()
        if text:
            self._idle_timer = asyncio.get_running_loop().call_later(self._idle_flush_s, self._release_finished_sentence)

    def flush(self) -> None:
        self._cancel_idle_timer()
        super().flush()

    def end_input(self) -> None:
        self._cancel_idle_timer()
        super().end_input()

    async def aclose(self) -> None:
        self._cancel_idle_timer()
        await super().aclose()

    def _cancel_idle_timer(self) -> None:
        if self._idle_timer is not None:
            self._idle_timer.cancel()
            self._idle_timer = None

    def _release_finished_sentence(self) -> None:
        self._idle_timer = None
        if self._event_ch.closed:
            return
        pending = f"{self._out_buf} {self._in_buf}" if self._out_buf and self._in_buf else self._out_buf or self._in_buf
        if not pending.strip() or not _SENTENCE_END.search(pending):
            return  # mid-sentence pause: keep waiting for more text
        # Same segment as push_text emissions; flush() would also start a new segment id.
        self._event_ch.send_nowait(TokenData(token=pending, segment_id=self._current_segment_id))
        self._in_buf = ""
        self._out_buf = ""


class IdleFlushSentenceTokenizer(tokenize.blingfire.SentenceTokenizer):
    def __init__(self, *, idle_flush_s: float = DEFAULT_IDLE_FLUSH_S, **kwargs) -> None:
        super().__init__(retain_format=True, **kwargs)
        self._idle_flush_s = idle_flush_s

    def stream(self, *, language: str | None = None) -> IdleFlushSentenceStream:
        base = super().stream(language=language)
        return IdleFlushSentenceStream(
            idle_flush_s=self._idle_flush_s,
            tokenizer=base._tokenize_fnc,
            min_token_len=base._min_token_len,
            min_ctx_len=base._min_ctx_len,
            max_token_len=base._max_token_len,
        )


def with_idle_sentence_flush(engine: tts.TTS, *, idle_flush_s: float = DEFAULT_IDLE_FLUSH_S) -> tts.TTS:
    """Wrap a non-streaming TTS ourselves so LiveKit doesn't apply its default sentence splitter."""
    if engine.capabilities.streaming:
        return engine
    return tts.StreamAdapter(tts=engine, sentence_tokenizer=IdleFlushSentenceTokenizer(idle_flush_s=idle_flush_s))
