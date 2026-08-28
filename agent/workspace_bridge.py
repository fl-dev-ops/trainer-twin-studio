import asyncio
import secrets
from typing import Any

from pipecat.pipeline.worker import PipelineWorker
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.processors.frameworks.rtvi import RTVIUICommandFrame, RTVIUIEventFrame


class WorkspaceBridge(FrameProcessor):
    """Correlate agent UI commands with browser results over RTVI."""

    def __init__(self, timeout: float = 15.0):
        super().__init__()
        self._timeout = timeout
        self._pending: dict[str, asyncio.Future[Any]] = {}

    async def command(self, worker: PipelineWorker, command: str, payload: dict) -> None:
        await worker.queue_frame(RTVIUICommandFrame(command=command, payload=payload))

    async def request(
        self,
        worker: PipelineWorker,
        method: str,
        action: str,
        payload: dict,
    ) -> Any:
        request_id = secrets.token_hex(8)
        future = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        await self.command(
            worker,
            "workspace.request",
            {
                "requestId": request_id,
                "method": method,
                "action": action,
                "payload": payload,
            },
        )
        try:
            return await asyncio.wait_for(future, self._timeout)
        except TimeoutError as error:
            raise RuntimeError(f"Workspace request timed out: {method}/{action}") from error
        finally:
            self._pending.pop(request_id, None)

    async def process_frame(self, frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, RTVIUIEventFrame) and frame.event == "workspace.result":
            data = frame.payload if isinstance(frame.payload, dict) else {}
            request_id = data.get("requestId")
            future = self._pending.get(request_id) if isinstance(request_id, str) else None
            if future and not future.done():
                error = data.get("error")
                if error:
                    future.set_exception(RuntimeError(str(error)))
                else:
                    future.set_result(data.get("result"))
            return
        await self.push_frame(frame, direction)

    def cancel_pending(self) -> None:
        for future in self._pending.values():
            if not future.done():
                future.cancel()
        self._pending.clear()
