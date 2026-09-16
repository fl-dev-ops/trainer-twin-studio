"""The only conversation client in bench/: the chat bridge over HTTP.

One Bridge instance = one durable eve session, keyed by the
x-trainertwin-session-id header. The bridge keeps history server-side,
so callers only send the latest user message (see
chat/agent/channels/openai-compat.ts: mapLatestMessage).
"""

import json
import time
import urllib.request
from uuid import uuid4

from conf import API_URL, MODEL, auth_headers, ssl_verify

# Transport tools the bridge will forward as tool_calls when advertised.
DEFAULT_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "surface",
            "parameters": {"type": "object", "properties": {"action": {"type": "string"}, "payload": {"type": "object"}}},
        },
    },
    {
        "type": "function",
        "function": {"name": "finish_session", "parameters": {"type": "object", "properties": {}}},
    },
]


class Bridge:
    def __init__(
        self,
        session_id: str | None = None,
        agent_slug: str | None = None,
        persona_slug: str | None = None,
        model: str | None = None,
        url: str | None = None,
    ):
        self.session_id = session_id or f"bench-{uuid4()}"
        self.url = ((url or API_URL).rstrip("/")) + "/v1/chat/completions"
        self.model = model or MODEL
        self.headers = auth_headers(self.session_id, agent_slug=agent_slug, persona_slug=persona_slug)
        self.verify = ssl_verify() if self.url.startswith("https") else True

    def send(self, content: str, tools: list | None = None, timeout: int = 90) -> dict:
        """Send the latest learner turn; returns text + bridge-reported metrics."""
        payload = {
            "model": self.model,
            "stream": True,
            "messages": [{"role": "user", "content": content}],
            **({"tools": tools} if tools else {}),
        }
        request = urllib.request.Request(
            self.url, data=json.dumps(payload).encode(), headers=self.headers
        )
        start = time.time()
        text = ""
        tools_called: list = []
        retrieval_traces: list = []
        ttft_ms = wall_ms = 0
        usage: dict = {}
        with urllib.request.urlopen(request, timeout=timeout) as response:
            for line in response:
                line = line.decode().strip()
                if not line.startswith("data: ") or line == "data: [DONE]":
                    continue
                chunk = json.loads(line[6:])
                delta = chunk.get("choices", [{}])[0].get("delta", {})
                if delta.get("content"):
                    text += delta["content"]
                if chunk.get("tools_called"):
                    tools_called = chunk["tools_called"]
                if chunk.get("retrieval_traces"):
                    retrieval_traces = chunk["retrieval_traces"]
                if chunk.get("ttft_ms"):
                    ttft_ms = chunk["ttft_ms"]
                if chunk.get("wall_ms"):
                    wall_ms = chunk["wall_ms"]
                if chunk.get("usage"):
                    usage = chunk["usage"]
        client_wall = int((time.time() - start) * 1000)
        return {
            "text": text,
            "tools_called": tools_called,
            "retrieval_traces": retrieval_traces,
            "ttft_ms": ttft_ms or client_wall,
            "wall_ms": wall_ms or client_wall,
            "usage": usage,
        }

    def open_session(self, timeout: int = 90) -> str:
        """Generate the session opening ("session-start" maps to [OPENING] in the bridge)."""
        return self.send("session-start", timeout=timeout)["text"]
