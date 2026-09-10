"""Agent server setup, status endpoint, prewarm, and main entry point."""

from __future__ import annotations

import asyncio
import logging
import os

from aiohttp import web
from livekit import agents

from .config import (
    MAX_CONCURRENT_SESSIONS,
    REGISTERED_AGENT_NAME,
    resolve_interview_catalog_path,
    resolve_profile_config_path,
)

logger = logging.getLogger("intervoo_agent")



def _prewarm(proc: agents.JobProcess) -> None:
    from domains.session.tts import validate_tts_provider_configuration
    from infrastructure.config.resources import prewarm_runtime_resources

    revision = (os.getenv("AGENT_BUILD_REVISION") or "unknown").strip() or "unknown"
    logger.info(
        "worker_start revision=%r",
        revision[:128],
    )
    validate_tts_provider_configuration()
    prewarm_runtime_resources(
        proc,
        profile_config_path=resolve_profile_config_path(),
        interview_catalog_path=resolve_interview_catalog_path(),
    )


def _compute_worker_load(current_server: agents.AgentServer) -> float:
    return 1.0 if len(current_server.active_jobs) >= MAX_CONCURRENT_SESSIONS else 0.0


server = agents.AgentServer(
    setup_fnc=_prewarm,
    initialize_process_timeout=120,
    shutdown_process_timeout=60,
    load_fnc=_compute_worker_load,
    load_threshold=0.5,
    job_memory_warn_mb=2048,
    job_memory_limit_mb=4096,
    num_idle_processes=1,
)

STATUS_HOST = os.getenv("STATUS_HOST", "127.0.0.1")
STATUS_PORT = int(os.getenv("STATUS_PORT", "8082"))


async def _status_handler(request: web.Request) -> web.Response:
    return web.json_response(
        {
            "active_jobs": len(server.active_jobs),
            "max": MAX_CONCURRENT_SESSIONS,
            "draining": server.draining,
        }
    )


async def _start_status_server() -> None:
    app = web.Application()
    app.add_routes([web.get("/status", _status_handler)])
    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, STATUS_HOST, STATUS_PORT).start()
    logger.info("status server listening on %s:%d/status", STATUS_HOST, STATUS_PORT)


def _on_worker_started() -> None:
    asyncio.get_event_loop().create_task(
        _start_status_server(), name="status-server"
    )


server.on("worker_started", _on_worker_started)


def register_entrypoint() -> None:
    from .lifecycle import entrypoint, on_session_end

    server.rtc_session(
        agent_name=REGISTERED_AGENT_NAME,
        on_session_end=on_session_end,
    )(entrypoint)


register_entrypoint()


def main() -> None:
    agents.cli.run_app(server)


if __name__ == "__main__":
    main()
