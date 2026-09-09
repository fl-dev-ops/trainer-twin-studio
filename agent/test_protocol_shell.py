"""Protocol Shell Verification: Real Pipecat OpenAILLMService tool loop + idempotency.

Tests:
1. Unauthorized request rejected (401).
2. Unmodified Pipecat OpenAILLMService: user -> two parallel tools -> both results -> spoken text.
3. Replayed identical POST returns the same body and same execution count (does not grade twice).
"""
import asyncio
import os
import subprocess
import time
import unittest
import httpx

from pipecat.frames.frames import EndWorkerFrame, LLMContextFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.workers.runner import WorkerRunner

PORT = 8997
BASE_URL = f"http://127.0.0.1:{PORT}/api/v1"
TOKEN = "test-token-step1"


class ProtocolShellTest(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        # Start Bun server serving the route
        web_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "web"))
        cls.server_proc = subprocess.Popen(
            [
                "bun",
                "-e",
                f'import {{ POST }} from "./app/api/v1/chat/completions/route.ts"; Bun.serve({{ port: {PORT}, fetch: (req) => POST(req) }}); console.log("READY");',
            ],
            cwd=web_dir,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        # Wait for READY
        start = time.time()
        ready = False
        while time.time() - start < 5:
            line = cls.server_proc.stdout.readline()
            if "READY" in line:
                ready = True
                break
            time.sleep(0.05)
        if not ready:
            cls.server_proc.kill()
            raise RuntimeError("Failed to start bun test server for protocol shell")

    @classmethod
    def tearDownClass(cls):
        if cls.server_proc:
            cls.server_proc.terminate()
            try:
                cls.server_proc.wait(timeout=2)
            except Exception:
                cls.server_proc.kill()

    async def test_01_unauthorized_rejected(self):
        async with httpx.AsyncClient() as client:
            res = await client.post(f"{BASE_URL}/chat/completions", json={"messages": []})
            self.assertEqual(res.status_code, 401)

    async def test_02_pipecat_unmodified_parallel_tool_loop(self):
        svc = OpenAILLMService(
            api_key=TOKEN,
            base_url=BASE_URL,
            settings=OpenAILLMService.Settings(model="trainertwin-runtime"),
        )
        tools_called = []

        async def h1(params):
            tools_called.append(("test_tool_1", params.arguments))
            await params.result_callback({"ack": 1})

        async def h2(params):
            tools_called.append(("test_tool_2", params.arguments))
            await params.result_callback({"ack": 2})

        svc.register_function("test_tool_1", h1)
        svc.register_function("test_tool_2", h2)

        context = LLMContext()
        user_agg, asst_agg = LLMContextAggregatorPair(context)
        pipeline = Pipeline([user_agg, svc, asst_agg])
        task = PipelineTask(pipeline, params=PipelineParams())
        runner = WorkerRunner(handle_sigint=False)
        await runner.add_workers(task)

        async def feed():
            await asyncio.sleep(0.1)
            c = LLMContext([{"role": "user", "content": "Trigger tool run"}])
            await task.queue_frame(LLMContextFrame(c))
            for _ in range(30):
                if len(tools_called) == 2:
                    break
                await asyncio.sleep(0.1)
            await asyncio.sleep(0.4)
            await task.queue_frame(EndWorkerFrame())

        await asyncio.gather(runner.run(), feed())

        self.assertEqual(len(tools_called), 2)
        self.assertEqual(tools_called[0][0], "test_tool_1")
        self.assertEqual(tools_called[1][0], "test_tool_2")

        # Verify assistant aggregator context contains spoken text
        messages = context.get_messages()
        last_msg = messages[-1]
        self.assertEqual(last_msg.get("role"), "assistant")
        self.assertIn("Both tools finished successfully", str(last_msg.get("content")))

    async def test_03_idempotency_retry_does_not_execute_twice(self):
        async with httpx.AsyncClient() as client:
            payload = {
                "model": "trainertwin-runtime",
                "messages": [{"role": "user", "content": "Idempotent turn"}],
                "stream": False,
            }
            headers = {"Authorization": f"Bearer {TOKEN}"}

            r1 = await client.post(f"{BASE_URL}/chat/completions", json=payload, headers=headers)
            r2 = await client.post(f"{BASE_URL}/chat/completions", json=payload, headers=headers)

            self.assertEqual(r1.status_code, 200)
            self.assertEqual(r2.status_code, 200)
            self.assertEqual(r2.headers.get("x-idempotent-replay"), "true")
            self.assertEqual(r1.headers.get("x-execution-count"), r2.headers.get("x-execution-count"))
            self.assertEqual(r1.json(), r2.json())


if __name__ == "__main__":
    unittest.main()
