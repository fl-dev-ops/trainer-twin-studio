"""Self-check: every live Studio persona × agent combination must compile.

Uses /api/agent-config (the same endpoint the voice bot consumes). When the
local database is unavailable, seed files provide the combination list.
Requires the studio web server running (default http://localhost:3000).
Run: .venv/bin/python check.py
"""

import asyncio
import subprocess
from pathlib import Path
import sys

import yaml

from interview import WEB_URL, build_specs, fetch_config
from runner import AgentSpec, DomainSpec, PersonaSpec


def db_combos() -> list[tuple[str, str]] | None:
    """Persona × agent pairs per org from the live Studio database (DB is authoritative)."""
    from dotenv import dotenv_values

    url = dotenv_values(Path(__file__).resolve().parent.parent / "web/.env").get("DATABASE_URL")
    if not url:
        return None
    # psql rejects Prisma's ?schema=public suffix.
    url = url.split("?", 1)[0]
    query = (
        'select p.slug || \' | \' || a.slug from "Persona" p '
        'join "Agent" a on a."orgId" = p."orgId";'
    )
    try:
        out = subprocess.run(["psql", url, "-qAt", "-c", query], capture_output=True, text=True, timeout=15)
    except FileNotFoundError:
        return None
    if out.returncode != 0:
        return None
    combos = []
    for line in out.stdout.splitlines():
        persona, _, agent = line.partition(" | ")
        if persona and agent:
            combos.append((persona, agent))
    return combos


async def main() -> int:
    combos = db_combos()
    source = "Studio database"
    if not combos:
        data = Path(__file__).resolve().parent.parent / "web/data"
        personas = [yaml.safe_load(p.read_text())["persona"]["id"] for p in sorted((data / "personas").glob("*.yaml"))]
        agents = [yaml.safe_load(p.read_text())["agent"]["id"] for p in sorted((data / "agents").glob("*.yaml"))]
        combos = [(p, a) for p in personas for a in agents]
        source = "web/data seed files"

    failures = []
    if not combos:
        failures.append("No persona × agent combinations found")
    print(f"Checking {len(combos)} combination(s) from the {source}.")

    for pid, aid in combos:
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
