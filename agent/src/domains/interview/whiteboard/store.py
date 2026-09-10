"""Whiteboard artifact store for S3 persistence."""

from __future__ import annotations

import asyncio
import logging
import time
from copy import deepcopy
from typing import Any

from domains.recording.config import RecordingConfig
from domains.recording.storage.store import upload_json, upload_png
from domains.recording.storage.url_builder import build_s3_key

logger = logging.getLogger(__name__)

S3_LOG_PREFIX = "[EXT-API:s3-whiteboard]"


class WhiteboardArtifactStore:
    def __init__(
        self,
        *,
        config: RecordingConfig,
        agent_type: str,
        room_name: str,
        answers: dict[str, dict[str, Any]],
    ) -> None:
        self._config = config
        self._agent_type = agent_type
        self._room_name = room_name
        self._answers = answers
        self._manifest_lock = asyncio.Lock()

    async def persist_image(self, question_id: str) -> None:
        answer = self._answers.get(question_id)
        if answer is None:
            return
        started = time.monotonic()
        key = build_s3_key(
            self._agent_type,
            self._room_name,
            f"whiteboards/{question_id}-{answer['image_sha256'][:12]}.png",
            self._config.s3_base_prefix,
        )
        try:
            await asyncio.wait_for(
                asyncio.to_thread(
                    upload_png,
                    self._config,
                    key,
                    answer["_image_bytes"],
                ),
                timeout=self._config.s3_upload_timeout_seconds,
            )
            answer["s3_key"] = key
            answer["persistence_status"] = "completed"
            logger.info(
                "%s uploaded question_id=%s bytes=%d elapsed_ms=%d",
                S3_LOG_PREFIX,
                question_id,
                answer["bytes"],
                int((time.monotonic() - started) * 1000),
            )
        except Exception as exc:
            answer["persistence_status"] = "failed"
            logger.error(
                "%s upload failed question_id=%s elapsed_ms=%d error=%s",
                S3_LOG_PREFIX,
                question_id,
                int((time.monotonic() - started) * 1000),
                exc,
            )
        await self.persist_manifest()

    async def persist_manifest(self) -> None:
        async with self._manifest_lock:
            entries = [
                {
                    "question_id": question_id,
                    **{
                        key: deepcopy(value)
                        for key, value in answer.items()
                        if not key.startswith("_")
                    },
                }
                for question_id, answer in self._answers.items()
            ]
            key = build_s3_key(
                self._agent_type,
                self._room_name,
                "whiteboards/manifest.json",
                self._config.s3_base_prefix,
            )
            try:
                await asyncio.wait_for(
                    asyncio.to_thread(
                        upload_json,
                        self._config,
                        key,
                        {"version": 1, "whiteboards": entries},
                    ),
                    timeout=self._config.s3_upload_timeout_seconds,
                )
            except Exception as exc:
                logger.error("%s manifest upload failed error=%s", S3_LOG_PREFIX, exc)
