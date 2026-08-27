"""Offline self-check: every persona × agent combination must build from the web API.

Requires the studio web server running (default http://localhost:3000).
Run: uv run python check.py
"""

import asyncio
import sys

import httpx

from interview import WEB_URL, build_specs, fetch_config
from runner import AgentSpec, DomainSpec, PersonaSpec


async def main() -> int:
    async with httpx.AsyncClient(timeout=30) as client:
        personas = (await client.get(f"{WEB_URL}/api/spec/personas")).json()["specs"]
        agents = (await client.get(f"{WEB_URL}/api/spec/agents")).json()["specs"]

    failures = []
    if not personas or not agents:
        failures.append("No personas or agents returned by the API — is the web server running?")

    for pid in personas:
        for aid in agents:
            try:
                config = await asyncio.to_thread(fetch_config, pid, aid)
                persona, agent, domain, kbs = build_specs(config)
                assert isinstance(persona, PersonaSpec)
                assert isinstance(agent, AgentSpec) and agent.phases, f"agent {aid} has no phases"
                assert isinstance(domain, DomainSpec) and domain.principles
                assert agent.required_evidence, f"agent {aid} has no evidence definitions"
                print(f"ok  {pid} × {aid}: {len(agent.phases)} phase(s), {len(agent.required_evidence)} evidence keys, {len(kbs)} indexed kb(s)")
            except Exception as error:
                failures.append(f"{pid} × {aid}: {type(error).__name__}: {error}")

    if failures:
        print("\nFAILURES:")
        for failure in failures:
            print(" -", failure)
        return 1
    print("\nAll spec combinations build cleanly from the API.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
