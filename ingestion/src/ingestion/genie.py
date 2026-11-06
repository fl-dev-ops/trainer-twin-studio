"""OpenAIGenie for OpenRouter with Qwen's reasoning off and a hard per-call time limit.

Why: with reasoning on, a split decision took 6 s and sometimes minutes; the stock genie's
600 s SDK timeout x 5 tenacity retries turned one slow call into a silent ~50 min stall.
Reasoning off gave the same split index in under 1 s.
"""
from __future__ import annotations

import logging
from typing import Any

from chonkie.genie import OpenAIGenie

log = logging.getLogger(__name__)
NO_REASONING = {"reasoning": {"enabled": False}}


class OpenRouterGenie(OpenAIGenie):
    def __init__(self, model: str, base_url: str, api_key: str, timeout: float = 60, max_retries: int = 2) -> None:
        super().__init__(model=model, base_url=base_url, api_key=api_key)
        # Bounded: at most (1 + max_retries) x timeout per call. No tenacity loop on top.
        self.client = self.client.with_options(timeout=timeout, max_retries=max_retries)

    def generate(self, prompt: str) -> str:
        r = self.client.chat.completions.create(model=self.model, messages=[{"role": "user", "content": prompt}],
                                                extra_body=NO_REASONING)
        content = r.choices[0].message.content
        if content is None:
            raise ValueError("empty LLM response")
        return content

    def generate_json(self, prompt: str, schema: Any) -> dict[str, Any]:
        try:
            r = self.client.beta.chat.completions.parse(model=self.model, messages=[{"role": "user", "content": prompt}],
                                                        response_format=schema, extra_body=NO_REASONING)
            parsed = r.choices[0].message.parsed
            if parsed is None:
                raise ValueError("LLM returned no parsable JSON")
            return parsed.model_dump()
        except Exception as e:
            # SlumberChunker swallows this and keeps the passages together; make it visible.
            log.warning("split decision failed (%s: %s)", type(e).__name__, str(e)[:200])
            raise
