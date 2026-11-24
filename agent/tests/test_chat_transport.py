import asyncio
import base64
from pathlib import Path

from livekit.agents import APIConnectOptions, llm

from session import DEFAULT_LLM_MODEL, build_agent_session


async def test_voice_worker_streams_opening_and_learner_reply_through_chat():
    chat = Path(__file__).resolve().parents[2] / "chat"
    process = await asyncio.create_subprocess_exec(
        "bun", "--no-env-file", "scripts/qa-voice-bridge.ts",
        cwd=chat,
        stdout=asyncio.subprocess.PIPE,
    )
    try:
        origin = (await asyncio.wait_for(process.stdout.readline(), timeout=10)).decode().strip()
        assert origin.startswith("http://127.0.0.1:"), "Chat QA bridge failed to start"
        credentials = base64.b64encode(b"voice-org-test:test-chat-secret").decode()
        session = build_agent_session(
            base_url=f"{origin}/v1",
            api_key="test-runtime-token",
            model=DEFAULT_LLM_MODEL,
            extra_headers={
                "Authorization": f"Basic {credentials}",
                "x-trainertwin-session-id": "voice-session-test",
                "x-trainertwin-runtime-token": "test-runtime-token",
                "x-trainertwin-mode": "voice",
            },
        )
        context = llm.ChatContext()
        turns = [
            ("system", "session-start", "Hi, let's practise."),
            ("user", "I would start by asking about your goals.", "Go on."),
        ]
        for role, message, expected in turns:
            context.add_message(role=role, content=message)
            async with session.llm.chat(
                chat_ctx=context, conn_options=APIConnectOptions(max_retry=0, timeout=3)
            ) as stream:
                reply = [
                    chunk.delta.content
                    async for chunk in stream
                    if chunk.delta and chunk.delta.content
                ]
            assert "".join(reply) == expected
            context.add_message(role="assistant", content=expected)
    finally:
        if process.returncode is None:
            process.terminate()
        await process.wait()
