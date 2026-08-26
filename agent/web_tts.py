"""TTS through the studio's /api/tts/speech proxy.

OpenAI-style request ({voice, input}) returning streamed raw PCM at 24 kHz
mono. Keeps TTS_SERVICE_URL / API keys on the web-app side.
"""

from typing import AsyncGenerator

import httpx
from loguru import logger
from pipecat.frames.frames import ErrorFrame, Frame, TTSAudioRawFrame
from pipecat.services.tts_service import TTSService

SAMPLE_RATE = 24000


class WebTTSService(TTSService):
    """Speaks text via WEB_URL/api/tts/speech using a Voice id as `voice`.

    `voice` is mutable: assign a Voice id any time (e.g. after the interview
    starts) and the next utterance uses it.
    """

    def __init__(self, web_url: str, voice: str = "", **kwargs):
        super().__init__(sample_rate=SAMPLE_RATE, **kwargs)
        self._web_url = web_url.rstrip("/")
        self.voice = voice

    async def run_tts(self, text: str, context_id: str) -> AsyncGenerator[Frame, None]:
        if not self.voice:
            yield ErrorFrame(error="No TTS voice configured for this agent")
            return
        try:
            async with httpx.AsyncClient(timeout=60) as client:
                async with client.stream(
                    "POST",
                    f"{self._web_url}/api/tts/speech",
                    json={
                        "voice": self.voice,
                        "input": text,
                        "stream": True,
                        "response_format": "pcm",
                    },
                ) as response:
                    if response.status_code != 200:
                        detail = (await response.aread()).decode(errors="replace")[:200]
                        yield ErrorFrame(error=f"TTS error {response.status_code}: {detail}")
                        return
                    async for chunk in response.aiter_bytes(self.chunk_size):
                        if chunk:
                            await self.stop_ttfb_metrics()
                            yield TTSAudioRawFrame(chunk, SAMPLE_RATE, 1, context_id=context_id)
        except Exception as error:
            logger.exception("Web TTS request failed")
            yield ErrorFrame(error=f"Web TTS request failed: {error}")
