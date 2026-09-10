"""Transcript normalization for session reports."""

from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Any

SCHEMA_VERSION = "1.0"


def _ts_to_iso(ts: float | None) -> str | None:
    if ts is None:
        return None
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


def _extract_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif hasattr(item, "text"):
                parts.append(item.text)
        return " ".join(parts)
    return str(content) if content else ""


def _chat_history_items(report_dict: dict[str, Any]) -> list[dict[str, Any]]:
    chat_history = report_dict.get("chat_history", {})
    if not isinstance(chat_history, dict):
        return []

    raw_items = chat_history.get("items")
    if isinstance(raw_items, list):
        return [item for item in raw_items if isinstance(item, dict)]

    raw_messages = chat_history.get("messages")
    if isinstance(raw_messages, list):
        return [item for item in raw_messages if isinstance(item, dict)]

    return []


def _extract_verbose_tools(
    chat_history: dict[str, Any] | None,
    events: list[Any] | None,
) -> dict[str, Any]:
    configured: list[str] = []
    calls_by_id: dict[str, dict[str, Any]] = {}

    raw_items = chat_history.get("items", []) if isinstance(chat_history, dict) else []
    items = [item for item in raw_items if isinstance(item, dict)]
    for item in items:
        tools_added = item.get("tools_added")
        if item.get("type") == "agent_config_update" and isinstance(tools_added, list):
            for tool in tools_added:
                if isinstance(tool, str) and tool not in configured:
                    configured.append(tool)

        if item.get("type") == "function_call":
            call_id = item.get("call_id")
            if isinstance(call_id, str) and call_id:
                calls_by_id.setdefault(
                    call_id,
                    {
                        "call_id": call_id,
                        "name": item.get("name"),
                        "arguments": item.get("arguments"),
                        "created_at": _ts_to_iso(item.get("created_at")),
                        "output": None,
                        "is_error": None,
                    },
                )

        if item.get("type") == "function_call_output":
            call_id = item.get("call_id")
            if isinstance(call_id, str) and call_id:
                call = calls_by_id.setdefault(
                    call_id,
                    {
                        "call_id": call_id,
                        "name": item.get("name"),
                        "arguments": None,
                        "created_at": None,
                    },
                )
                call["output"] = item.get("output")
                call["is_error"] = item.get("is_error")
                call["output_created_at"] = _ts_to_iso(item.get("created_at"))

    for event in events or []:
        if not isinstance(event, dict) or event.get("type") != "function_tools_executed":
            continue
        function_calls = event.get("function_calls", [])
        function_outputs = event.get("function_call_outputs", [])
        if not isinstance(function_calls, list):
            continue
        if not isinstance(function_outputs, list):
            function_outputs = []

        for index, function_call in enumerate(function_calls):
            if not isinstance(function_call, dict):
                continue
            call_id = function_call.get("call_id")
            if not isinstance(call_id, str) or not call_id:
                continue
            output = function_outputs[index] if index < len(function_outputs) else None
            call = calls_by_id.setdefault(
                call_id,
                {
                    "call_id": call_id,
                    "name": function_call.get("name"),
                    "arguments": function_call.get("arguments"),
                    "created_at": _ts_to_iso(function_call.get("created_at")),
                    "output": None,
                    "is_error": None,
                },
            )
            call["event_created_at"] = _ts_to_iso(event.get("created_at"))
            if isinstance(output, dict):
                call["output"] = output.get("output")
                call["is_error"] = output.get("is_error")
                output_created_at = _ts_to_iso(output.get("created_at"))
                if output_created_at is not None:
                    call["output_created_at"] = output_created_at

    return {
        "configured": configured,
        "calls": list(calls_by_id.values()),
    }


def normalize_session_report(
    report_dict: dict[str, Any],
    *,
    agent_type: str,
    agent_name: str,
    egress_id: str | None = None,
    egress_status: str | None = None,
    resolved_user_id: str | None = None,
    participant_identity: str | None = None,
    phone_number: str | None = None,
) -> dict[str, Any]:
    session_started = report_dict.get("started_at")
    session_timestamp = report_dict.get("timestamp", time.time())
    duration = report_dict.get("duration")

    turns = []
    messages = _chat_history_items(report_dict)
    chat_history = report_dict.get("chat_history")
    resolved_chat_history = chat_history if isinstance(chat_history, dict) else {}
    events = report_dict.get("events", [])
    resolved_events = events if isinstance(events, list) else []
    tools = _extract_verbose_tools(resolved_chat_history, resolved_events)

    for idx, msg in enumerate(messages):
        if msg.get("type") not in (None, "message"):
            continue

        role = msg.get("role", "unknown")
        text = _extract_text(msg.get("content", ""))
        if not text:
            continue

        turn: dict[str, Any] = {
            "index": idx,
            "role": role,
            "text": text,
        }

        create_ts = msg.get("create_time") or msg.get("created_at")
        if create_ts:
            turn["timestamp"] = _ts_to_iso(create_ts)

        if msg.get("interrupted"):
            turn["interrupted"] = True

        tool_name = msg.get("tool_name")
        if tool_name:
            turn["tool_name"] = tool_name

        turns.append(turn)

    usage: dict[str, Any] = {}
    options = report_dict.get("options", {})
    if options:
        usage["model"] = options.get("llm", {}).get("model")

    metadata_events = []
    for ev in resolved_events:
        if isinstance(ev, dict):
            metadata_events.append(
                {k: v for k, v in ev.items() if k in ("type", "timestamp")}
            )

    return {
        "schema_version": SCHEMA_VERSION,
        "session": {
            "agent_type": agent_type,
            "agent_name": agent_name,
            "room": report_dict.get("room"),
            "room_id": report_dict.get("room_id"),
            "job_id": report_dict.get("job_id"),
            "egress_id": egress_id,
            "egress_status": egress_status,
            "started_at": _ts_to_iso(session_started),
            "ended_at": _ts_to_iso(session_timestamp),
            "duration_seconds": round(duration, 2) if duration else None,
        },
        "subject": {
            "resolved_user_id": resolved_user_id,
            "participant_identity": participant_identity,
            "phone_number": phone_number,
        },
        "turns": turns,
        "tools": tools,
        "usage": usage,
        "metadata": {
            "event_count": len(resolved_events),
            "turn_count": len(turns),
            "tool_call_count": len(tools["calls"]),
            "events_summary": metadata_events[:20],
        },
    }


def normalize_metrics_payload(
    report_dict: dict[str, Any],
    *,
    agent_type: str,
    agent_name: str,
    egress_id: str | None = None,
    egress_status: str | None = None,
    resolved_user_id: str | None = None,
    participant_identity: str | None = None,
    phone_number: str | None = None,
    events: list[dict[str, Any]] | None = None,
    usage_summary: dict[str, Any] | None = None,
) -> dict[str, Any]:
    session_started = report_dict.get("started_at")
    session_timestamp = report_dict.get("timestamp", time.time())
    duration = report_dict.get("duration")
    resolved_events = events
    if resolved_events is None:
        report_events = report_dict.get("events")
        resolved_events = report_events if isinstance(report_events, list) else []

    return {
        "schema_version": SCHEMA_VERSION,
        "session": {
            "agent_type": agent_type,
            "agent_name": agent_name,
            "room": report_dict.get("room"),
            "room_id": report_dict.get("room_id"),
            "job_id": report_dict.get("job_id"),
            "egress_id": egress_id,
            "egress_status": egress_status,
            "started_at": _ts_to_iso(session_started),
            "ended_at": _ts_to_iso(session_timestamp),
            "duration_seconds": round(duration, 2) if duration else None,
        },
        "subject": {
            "resolved_user_id": resolved_user_id,
            "participant_identity": participant_identity,
            "phone_number": phone_number,
        },
        "usage_summary": usage_summary or {},
        "events": resolved_events,
        "metadata": {"event_count": len(resolved_events)},
    }


def normalize_verbose_payload(
    report_dict: dict[str, Any],
    *,
    agent_type: str,
    agent_name: str,
    egress_id: str | None = None,
    egress_status: str | None = None,
    resolved_user_id: str | None = None,
    participant_identity: str | None = None,
    phone_number: str | None = None,
) -> dict[str, Any]:
    session_started = report_dict.get("started_at")
    session_timestamp = report_dict.get("timestamp", time.time())
    duration = report_dict.get("duration")
    chat_history = report_dict.get("chat_history")
    events = report_dict.get("events")
    resolved_chat_history = chat_history if isinstance(chat_history, dict) else {}
    resolved_events = events if isinstance(events, list) else []
    tools = _extract_verbose_tools(resolved_chat_history, resolved_events)

    return {
        "schema_version": SCHEMA_VERSION,
        "session": {
            "agent_type": agent_type,
            "agent_name": agent_name,
            "room": report_dict.get("room"),
            "room_id": report_dict.get("room_id"),
            "job_id": report_dict.get("job_id"),
            "egress_id": egress_id,
            "egress_status": egress_status,
            "started_at": _ts_to_iso(session_started),
            "ended_at": _ts_to_iso(session_timestamp),
            "duration_seconds": round(duration, 2) if duration else None,
        },
        "subject": {
            "resolved_user_id": resolved_user_id,
            "participant_identity": participant_identity,
            "phone_number": phone_number,
        },
        "tools": tools,
        "chat_history": resolved_chat_history,
        "events": resolved_events,
        "usage": report_dict.get("usage"),
        "raw_report": report_dict,
        "metadata": {
            "event_count": len(resolved_events),
            "chat_item_count": len(resolved_chat_history.get("items", []))
            if isinstance(resolved_chat_history.get("items"), list)
            else 0,
            "tool_call_count": len(tools["calls"]),
        },
    }
