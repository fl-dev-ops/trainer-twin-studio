"""LiveKit TTS adapter for TrainerTwin VoxCPM2 voice cloning via HTTP streaming.

Matches the OpenAI-compatible speech streaming protocol used by TrainerTwin:
    POST /v1/audio/speech or /api/tts/speech
    {"model": "voxcpm2", "voice": "<voice-id>", "input": "...", "stream": true, "response_format": "pcm"}
Returns streamed 16-bit raw PCM chunks with optional X-Sample-Rate header.
"""

from __future__ import annotations

import logging
import os
import time
import uuid
from typing import Any
from urllib.parse import urlsplit

import aiohttp
from livekit.agents import (
    DEFAULT_API_CONNECT_OPTIONS,
    APIConnectionError,
    APIConnectOptions,
    APIStatusError,
    APITimeoutError,
    get_job_context,
    tts,
)

DEFAULT_SAMPLE_RATE = 48_000
DEFAULT_NUM_CHANNELS = 1
PCM_CONTENT_TYPE = "audio/pcm"

logger = logging.getLogger(__name__)


class VoxCPM2TTS(tts.TTS):
    def __init__(
        self,
        *,
        endpoint: str,
        voice: str = "",
        api_key: str = "",
        sample_rate: int = DEFAULT_SAMPLE_RATE,
        connect_timeout: float = 10.0,
        total_timeout: float = 60.0,
        max_retries: int = 2,
        retry_interval: float = 0.5,
    ) -> None:
        super().__init__(
            capabilities=tts.TTSCapabilities(streaming=False),
            sample_rate=sample_rate,
            num_channels=DEFAULT_NUM_CHANNELS,
        )
        parsed_endpoint = urlsplit(endpoint)
        if parsed_endpoint.scheme not in {"http", "https"} or not parsed_endpoint.hostname:
            raise ValueError(f"VOXCPM2 endpoint must be a valid HTTP(S) URL: {endpoint}")

        self.endpoint = endpoint
        self.voice = voice
        self.api_key = api_key
        self.model_label = "voxcpm2"
        self.connect_timeout = connect_timeout
        self.total_timeout = total_timeout
        self.connect_options = APIConnectOptions(
            max_retry=max_retries,
            retry_interval=retry_interval,
            timeout=connect_timeout,
        )
        self.http: aiohttp.ClientSession | None = None

        job_context = get_job_context(required=False)
        if job_context is not None:
            job_context.add_shutdown_callback(self.aclose)

    @property
    def model(self) -> str:
        return self.model_label

    @property
    def provider(self) -> str:
        return "voxcpm2"

    def update_voice(self, voice: str) -> None:
        """Update voice id dynamically when session starts."""
        if voice:
            self.voice = voice

    def synthesize(
        self,
        text: str,
        *,
        conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
    ) -> tts.ChunkedStream:
        return VoxCPM2Stream(
            tts=self,
            input_text=text,
            conn_options=self.connect_options,
        )

    def session(self) -> aiohttp.ClientSession:
        if self.http is None or self.http.closed:
            self.http = aiohttp.ClientSession()
        return self.http

    async def aclose(self) -> None:
        if self.http is not None:
            await self.http.close()
            self.http = None


class VoxCPM2Stream(tts.ChunkedStream):
    async def _run(self, output: tts.AudioEmitter) -> None:
        vox = self._tts
        assert isinstance(vox, VoxCPM2TTS)
        request_id = uuid.uuid4().hex
        started_at = time.perf_counter()
        emitted_bytes = 0
        first_audio_at: float | None = None

        headers = {"Content-Type": "application/json"}
        if vox.api_key:
            headers["Authorization"] = f"Bearer {vox.api_key}"

        payload = {
            "model": vox.model,
            "voice": vox.voice or "default",
            "input": self.input_text,
            "stream": True,
            "response_format": "pcm",
        }

        logger.info(
            "[TTS:voxcpm2] start request_id=%s host=%s voice=%s",
            request_id,
            urlsplit(vox.endpoint).hostname,
            vox.voice or "default",
        )

        try:
            async with vox.session().post(
                vox.endpoint,
                headers=headers,
                json=payload,
                timeout=aiohttp.ClientTimeout(
                    total=vox.total_timeout,
                    sock_connect=vox.connect_timeout,
                ),
            ) as response:
                server_request_id = response.headers.get("X-Request-ID")
                if server_request_id:
                    request_id = server_request_id

                if response.status != 200:
                    body = (await response.read()).decode(errors="replace")[:300]
                    raise APIStatusError(
                        f"VoxCPM2 TTS request failed: {body}",
                        status_code=response.status,
                        request_id=request_id,
                        retryable=response.status in {408, 429} or response.status >= 500,
                    )

                # Read sample rate header if available
                sample_rate = vox.sample_rate
                if "X-Sample-Rate" in response.headers:
                    try:
                        sample_rate = int(response.headers["X-Sample-Rate"])
                    except ValueError:
                        pass

                output.initialize(
                    request_id=request_id,
                    sample_rate=sample_rate,
                    num_channels=DEFAULT_NUM_CHANNELS,
                    mime_type=PCM_CONTENT_TYPE,
                )

                async for chunk in response.content.iter_any():
                    if not chunk:
                        continue
                    if first_audio_at is None:
                        first_audio_at = time.perf_counter()
                        logger.info(
                            "[TTS:voxcpm2] first audio request_id=%s ttfa_ms=%.1f",
                            request_id,
                            (first_audio_at - started_at) * 1000,
                        )
                    output.push(chunk)
                    emitted_bytes += len(chunk)

                if emitted_bytes == 0:
                    raise APIConnectionError(
                        "VoxCPM2 TTS returned an empty audio stream",
                        retryable=True,
                    )

                output.flush()
                elapsed_ms = (time.perf_counter() - started_at) * 1000
                ttfa_ms = (
                    (first_audio_at - started_at) * 1000
                    if first_audio_at is not None
                    else -1
                )
                logger.info(
                    "[TTS:voxcpm2] complete request_id=%s elapsed_ms=%.1f ttfa_ms=%.1f audio_bytes=%d",
                    request_id,
                    elapsed_ms,
                    ttfa_ms,
                    emitted_bytes,
                )
        except APIStatusError:
            logger.exception(
                "[TTS:voxcpm2] error request_id=%s elapsed_ms=%.1f audio_bytes=%d",
                request_id,
                (time.perf_counter() - started_at) * 1000,
                emitted_bytes,
            )
            raise
        except APIConnectionError:
            logger.warning(
                "[TTS:voxcpm2] error request_id=%s elapsed_ms=%.1f audio_bytes=%d",
                request_id,
                (time.perf_counter() - started_at) * 1000,
                emitted_bytes,
            )
            raise
        except TimeoutError as error:
            logger.warning(
                "[TTS:voxcpm2] error request_id=%s elapsed_ms=%.1f audio_bytes=%d error_type=timeout",
                request_id,
                (time.perf_counter() - started_at) * 1000,
                emitted_bytes,
            )
            raise APITimeoutError(retryable=emitted_bytes == 0) from error
        except aiohttp.ClientError as error:
            logger.warning(
                "[TTS:voxcpm2] error request_id=%s elapsed_ms=%.1f audio_bytes=%d error_type=%s",
                request_id,
                (time.perf_counter() - started_at) * 1000,
                emitted_bytes,
                type(error).__name__,
            )
            raise APIConnectionError(
                "VoxCPM2 TTS connection failed",
                retryable=emitted_bytes == 0,
            ) from error


def build_voxcpm2_tts(session_config: Any | None = None) -> VoxCPM2TTS:
    endpoint = (
        os.getenv("VOXCPM2_ENDPOINT")
        or os.getenv("TTS_SERVICE_URL")
        or f"{os.getenv('WEB_URL', 'http://localhost:3000').rstrip('/')}/api/tts/speech"
    )
    if not endpoint.endswith("/v1/audio/speech") and not endpoint.endswith("/api/tts/speech"):
        endpoint = f"{endpoint.rstrip('/')}/v1/audio/speech"

    voice = ""
    if session_config and getattr(session_config, "voice", None):
        voice = str(session_config.voice).strip()
    if not voice:
        voice = (
            os.getenv("AGENT_VOICE_ID_OVERRIDE")
            or os.getenv("AGENT_DEFAULT_VOICE_ID")
            or os.getenv("VOXCPM_VOICE", "")
        ).strip()

    api_key = os.getenv("TTS_API_KEY") or os.getenv("TTS_SERVICE_KEY", "")

    return VoxCPM2TTS(
        endpoint=endpoint,
        voice=voice,
        api_key=api_key,
        sample_rate=DEFAULT_SAMPLE_RATE,
    )


def validate_voxcpm2_configuration() -> None:
    endpoint = (
        os.getenv("VOXCPM2_ENDPOINT")
        or os.getenv("TTS_SERVICE_URL")
        or f"{os.getenv('WEB_URL', 'http://localhost:3000').rstrip('/')}/api/tts/speech"
    )
    parsed = urlsplit(endpoint)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError(f"Invalid VoxCPM2 endpoint: {endpoint}")
