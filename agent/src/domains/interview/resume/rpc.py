"""Bounded Resume viewer readiness and claim-highlight RPC client."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from enum import Enum
from typing import Any

logger = logging.getLogger(__name__)

RESUME_RPC_METHOD = "workspace.resume"
RESUME_RPC_SCHEMA = "resume_rpc.v1"
STATUS_ATTEMPTS = 6
STATUS_WINDOW_SECONDS = 12.0
HIGHLIGHT_ATTEMPTS = 3
RPC_ATTEMPT_TIMEOUT_SECONDS = 2.0


class ResumeHighlightStatus(str, Enum):
    HIGHLIGHTED = "highlighted"
    NOT_FOUND = "not_found"
    VIEWER_UNAVAILABLE = "viewer_unavailable"
    DOCUMENT_MISMATCH = "document_mismatch"


@dataclass(frozen=True)
class ResumeHighlightResult:
    status: ResumeHighlightStatus


class ResumeRpcClient:
    """Resolve a matching ready document before highlighting one claim."""

    def __init__(
        self,
        *,
        room: Any,
        participant_identity: str,
        document_sha256: str,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._room = room
        self._participant_identity = participant_identity
        self._document_sha256 = document_sha256
        self._sleep = sleep
        self._clock = clock

    async def highlight_claim(self, claim_id: str) -> ResumeHighlightResult:
        readiness = await self._wait_for_ready(claim_id)
        if readiness != "ready":
            status = (
                ResumeHighlightStatus.DOCUMENT_MISMATCH
                if readiness == "document_mismatch"
                else ResumeHighlightStatus.VIEWER_UNAVAILABLE
            )
            return ResumeHighlightResult(status=status)

        for attempt in range(1, HIGHLIGHT_ATTEMPTS + 1):
            status = await self._perform(
                action="highlight_claim",
                attempt=attempt,
                claim_id=claim_id,
                response_timeout=RPC_ATTEMPT_TIMEOUT_SECONDS,
            )
            if status == ResumeHighlightStatus.HIGHLIGHTED.value:
                return ResumeHighlightResult(ResumeHighlightStatus.HIGHLIGHTED)
            if status == ResumeHighlightStatus.NOT_FOUND.value:
                return ResumeHighlightResult(ResumeHighlightStatus.NOT_FOUND)
            if status == ResumeHighlightStatus.DOCUMENT_MISMATCH.value:
                return ResumeHighlightResult(
                    ResumeHighlightStatus.DOCUMENT_MISMATCH
                )
        return ResumeHighlightResult(ResumeHighlightStatus.VIEWER_UNAVAILABLE)

    async def _wait_for_ready(self, claim_id: str) -> str:
        deadline = self._clock() + STATUS_WINDOW_SECONDS
        for attempt in range(1, STATUS_ATTEMPTS + 1):
            remaining = deadline - self._clock()
            if remaining <= 0:
                break
            status = await self._perform(
                action="get_status",
                attempt=attempt,
                claim_id=claim_id,
                response_timeout=min(RPC_ATTEMPT_TIMEOUT_SECONDS, remaining),
            )
            if status in {"ready", "document_mismatch"}:
                return status
            if attempt < STATUS_ATTEMPTS:
                remaining = deadline - self._clock()
                if remaining > 0:
                    await self._sleep(
                        min(STATUS_WINDOW_SECONDS / STATUS_ATTEMPTS, remaining)
                    )
        return ResumeHighlightStatus.VIEWER_UNAVAILABLE.value

    async def _perform(
        self,
        *,
        action: str,
        attempt: int,
        claim_id: str,
        response_timeout: float,
    ) -> str:
        started = self._clock()
        logger.info(
            "[EXT-API:resume-rpc] action=%s status=started attempt=%d "
            "elapsed_ms=0 claim_id=%s",
            action,
            attempt,
            claim_id,
        )
        payload: dict[str, object] = {
            "schema_version": RESUME_RPC_SCHEMA,
            "action": action,
            "payload": {"document_sha256": self._document_sha256},
        }
        if action == "highlight_claim":
            request_payload = payload["payload"]
            assert isinstance(request_payload, dict)
            request_payload["claim_id"] = claim_id
        try:
            # UNVERIFIED against LiveKit MCP; checked against pinned 1.6.6 source and docs.
            response = await self._room.local_participant.perform_rpc(
                destination_identity=self._participant_identity,
                method=RESUME_RPC_METHOD,
                payload=json.dumps(payload, separators=(",", ":")),
                response_timeout=response_timeout,
                max_round_trip_latency=response_timeout,
            )
            result = json.loads(response)
            status = self._response_status(action, claim_id, result)
        except Exception:
            status = ResumeHighlightStatus.VIEWER_UNAVAILABLE.value
        logger.info(
            "[EXT-API:resume-rpc] action=%s status=%s attempt=%d "
            "elapsed_ms=%d claim_id=%s",
            action,
            status,
            attempt,
            round((self._clock() - started) * 1000),
            claim_id,
        )
        return status

    def _response_status(self, action: str, claim_id: str, value: object) -> str:
        if not isinstance(value, Mapping):
            return ResumeHighlightStatus.VIEWER_UNAVAILABLE.value
        allowed_keys = {"schema_version", "ok", "status"}
        allowed_keys.update(
            {"page_count", "anchor_count", "claim_count"}
            if action == "get_status"
            else {"claim_id", "page"}
        )
        if set(value) - allowed_keys:
            return ResumeHighlightStatus.VIEWER_UNAVAILABLE.value
        if value.get("schema_version") != RESUME_RPC_SCHEMA:
            return ResumeHighlightStatus.VIEWER_UNAVAILABLE.value
        if value.get("ok") is not True:
            return ResumeHighlightStatus.VIEWER_UNAVAILABLE.value
        status = value.get("status")
        allowed = (
            {"ready", "loading", "document_mismatch"}
            if action == "get_status"
            else {
                ResumeHighlightStatus.HIGHLIGHTED.value,
                ResumeHighlightStatus.NOT_FOUND.value,
                ResumeHighlightStatus.VIEWER_UNAVAILABLE.value,
                ResumeHighlightStatus.DOCUMENT_MISMATCH.value,
            }
        )
        if status not in allowed:
            return ResumeHighlightStatus.VIEWER_UNAVAILABLE.value
        if action == "get_status":
            for key in ("page_count", "anchor_count", "claim_count"):
                count = value.get(key)
                if isinstance(count, bool) or not isinstance(count, int) or count < 0:
                    return ResumeHighlightStatus.VIEWER_UNAVAILABLE.value
        else:
            response_claim_id = value.get("claim_id")
            if response_claim_id is not None and response_claim_id != claim_id:
                return ResumeHighlightStatus.VIEWER_UNAVAILABLE.value
            page = value.get("page")
            if page is not None and (
                isinstance(page, bool) or not isinstance(page, int) or page <= 0
            ):
                return ResumeHighlightStatus.VIEWER_UNAVAILABLE.value
            if status == ResumeHighlightStatus.HIGHLIGHTED.value and (
                response_claim_id != claim_id or page is None
            ):
                return ResumeHighlightStatus.VIEWER_UNAVAILABLE.value
        return str(status)
