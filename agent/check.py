"""Compile one authorized live session through the same API used by the voice bot.

Run with SESSION_ID and SESSION_RUNTIME_TOKEN from an authenticated session launch:
    SESSION_ID=... SESSION_RUNTIME_TOKEN=... uv run python check.py
"""

import asyncio
import os
import sys

from interview import build_specs, fetch_config
from runner import AgentSpec, DomainSpec, PersonaSpec


async def main() -> int:
    session_id = os.getenv("SESSION_ID", "")
    runtime_token = os.getenv("SESSION_RUNTIME_TOKEN", "")
    if not session_id or not runtime_token:
        print("SESSION_ID and SESSION_RUNTIME_TOKEN are required")
        return 2
    try:
        config = await asyncio.to_thread(fetch_config, session_id, runtime_token)
        persona, agent, domain, knowledge_bases = build_specs(config)
        assert isinstance(persona, PersonaSpec)
        assert isinstance(agent, AgentSpec) and agent.phases
        assert isinstance(domain, DomainSpec) and domain.principles
        assert agent.required_evidence
        print(
            f"ok {session_id}: {persona.id} × {agent.id}, "
            f"{len(agent.phases)} phase(s), {len(knowledge_bases)} indexed knowledge base(s)"
        )
        return 0
    except Exception as error:
        print(f"FAIL: {type(error).__name__}: {error}")
        return 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
