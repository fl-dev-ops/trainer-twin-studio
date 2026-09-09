import uuid
from loguru import logger
from pipecat.services.openai.llm import OpenAILLMService


INTERVIEW_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "surface",
            "description": "Open or close an interview workspace surface (e.g., code editor, whiteboard, pdf, presentation).",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": [
                            "open_code_editor",
                            "open_whiteboard",
                            "open_pdf",
                            "open_presentation",
                            "close_surface",
                        ],
                    },
                    "payload": {"type": "object"},
                },
                "required": ["action"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "finish_session",
            "description": "Signals the interview conclusion. Arms closing gate to wrap closing remarks.",
            "parameters": {
                "type": "object",
                "properties": {},
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "workspace_request",
            "description": "Request an action or state from the browser workspace over RTVI.",
            "parameters": {
                "type": "object",
                "properties": {
                    "method": {"type": "string"},
                    "action": {"type": "string"},
                    "payload": {"type": "object"},
                },
                "required": ["method", "action"],
            },
        },
    },
]


def register_interview_tools(
    llm: OpenAILLMService,
    worker,
    workspace,
    closing_gate,
    surface_state: dict,
):
    """Register ordinary Pipecat handlers for interview runtime tools."""

    async def handle_finish_session(params):
        logger.info("finish_session invoked by web runtime")
        closing_gate.arm()
        await params.result_callback({"status": "completed"})

    async def handle_surface(params):
        action = params.arguments.get("action")
        payload = params.arguments.get("payload") or {}
        logger.info("surface action invoked: {} payload: {}", action, payload)
        if action == "close_surface":
            await workspace.command(
                worker,
                "surface",
                {
                    "action": "close_surface",
                    "eventId": uuid.uuid4().hex,
                    "payload": {},
                },
            )
            surface_state["current"] = None
        elif action:
            await workspace.command(
                worker,
                "surface",
                {
                    "action": action,
                    "eventId": uuid.uuid4().hex,
                    "payload": payload,
                },
            )
            surface_state["current"] = action
        await params.result_callback({"status": "ok", "action": action})

    async def handle_workspace_request(params):
        method = params.arguments.get("method", "")
        action = params.arguments.get("action", "")
        payload = params.arguments.get("payload") or {}
        try:
            result = await workspace.request(worker, method, action, payload)
            await params.result_callback({"status": "ok", "result": result})
        except Exception as error:
            logger.exception("workspace request failed")
            await params.result_callback({"status": "error", "error": str(error)})

    llm.register_function("finish_session", handle_finish_session)
    llm.register_function("surface", handle_surface)
    llm.register_function("workspace_request", handle_workspace_request)
