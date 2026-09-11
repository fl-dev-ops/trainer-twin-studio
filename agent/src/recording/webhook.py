"""Dispatch session finalization webhook to TrainerTwin web app."""

from __future__ import annotations

import asyncio
import json
import logging
import os
from urllib import error, request
from typing import Any

logger = logging.getLogger(__name__)


async def post_completion_webhook(
    webhook_url: str,
    payload: dict[str, Any],
) -> None:
    if not webhook_url:
        return

    def _send() -> None:
        body = json.dumps(payload, default=str).encode("utf-8")
        logger.info("Posting session webhook to %s", webhook_url)
        req = request.Request(
            webhook_url,
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        ssl_ctx = None
        if webhook_url.startswith("https://") and ".localhost" in webhook_url:
            import ssl
            ca_path = os.path.expanduser("~/.portless/ca.pem")
            if os.path.exists(ca_path):
                ssl_ctx = ssl.create_default_context(cafile=ca_path)
            else:
                ssl_ctx = ssl._create_unverified_context()
        with request.urlopen(req, timeout=15, context=ssl_ctx) as response:
            status = getattr(response, "status", response.getcode())
            if status >= 400:
                raise RuntimeError(f"Webhook returned HTTP {status}")

    try:
        # one retry on transient server errors — a missed delivery loses the recording keys permanently
        for attempt in range(2):
            try:
                await asyncio.to_thread(_send)
                logger.info("Webhook successfully delivered to %s", webhook_url)
                return
            except error.HTTPError as err:
                if err.code < 500 or attempt == 1:
                    raise
                await asyncio.sleep(2)
    except error.HTTPError as err:
        logger.error("Webhook failed for %s with HTTP %s: %s", webhook_url, err.code, err.reason)
    except Exception as exc:
        logger.error("Webhook delivery failed for %s: %s", webhook_url, exc)
