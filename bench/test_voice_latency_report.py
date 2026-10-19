import json

from voice_latency_report import parse_brain_traces, parse_events, parse_runtime_events, percentile, summarize


def test_voice_latency_report_parses_mixed_logs_and_calculates_percentiles():
    lines = [
        "unrelated log\n",
        'agent | [voice-latency] {"sessionId":"s1","turnIndex":1,"role":"user","endOfTurnDelayMs":500,"transcriptionDelayMs":100,"sttProvider":"deepgram","sttModel":"flux"}\n',
        'agent | [voice-latency] {"sessionId":"s1","turnIndex":1,"role":"assistant","llmTtftMs":1000,"ttsTtfbMs":200,"e2eLatencyMs":1800,"llmProvider":"groq","llmModel":"gpt-oss","ttsProvider":"sarvam","ttsModel":"bulbul"}\n',
        'agent | [voice-latency] {"sessionId":"s2","turnIndex":1,"role":"assistant","llmTtftMs":3000,"ttsTtfbMs":400,"e2eLatencyMs":4200}\n',
        'web | [runtime-latency] {"sessionId":"s1","completionId":"c1","revision":2,"turn":"learner","latencyMs":1500,"stages":[{"stage":"move","ms":500},{"stage":"styled_generation","ms":800}]}\n',
        "agent | [voice-latency] not-json\n",
    ]

    events = parse_events(lines)
    runtime_events = parse_runtime_events(lines)
    report = summarize(events, label="baseline-v1", runtime_events=runtime_events)

    assert len(events) == 3
    assert percentile([1000, 3000], 0.5) == 2000
    assert report["sessionCount"] == 2
    assert report["turnCount"] == 2
    assert report["completeTurnCount"] == 1
    assert report["incompleteTurns"] == [
        {
            "sessionId": "s2",
            "turnIndex": 1,
            "missingMetrics": ["transcriptionDelayMs", "endOfTurnDelayMs"],
        }
    ]
    assert report["providers"] == ["deepgram/flux", "groq/gpt-oss", "sarvam/bulbul"]
    assert report["runtimeStagesMs"]["move"]["p50"] == 500
    assert report["runtimeCompletions"][0]["completionId"] == "c1"
    assert report["metricsMs"]["llmTtftMs"] == {
        "count": 2,
        "min": 1000,
        "p50": 2000.0,
        "p90": 2800.0,
        "p95": 2900.0,
        "max": 3000,
    }


def test_voice_latency_report_breaks_down_eve_brain_traces_per_llm_and_tool_call():
    lines = [
        'eve | [brain-trace] {"sessionId":"s1","mode":"voice","model":"google/gemini-3.8-flash","total_turn_ms":2400,"first_token_ttft_ms":1900,"call1_tool_decision_ms":700,"tools_executed":[{"name":"search_style","callId":"a","duration_ms":300},{"name":"search_style","callId":"b","duration_ms":100}],"call2_answer_ttft_ms":600,"llm_steps":[{"stepIndex":1,"start_ms":5,"ttft_ms":650,"duration_ms":700},{"stepIndex":2,"start_ms":1120,"ttft_ms":600,"duration_ms":1200}],"prompt_tokens":3000,"completion_tokens":80}\n',
        'eve | [brain-trace] {"sessionId":"s1","model":"google/gemini-3.8-flash","total_turn_ms":1500,"first_token_ttft_ms":900,"tools_executed":[],"llm_steps":[{"stepIndex":1,"start_ms":3,"ttft_ms":900,"duration_ms":1400}]}\n',
    ]

    traces = parse_brain_traces(lines)
    report = summarize([], label="eve-gemini-v1", brain_traces=traces)

    assert report["brainModels"] == ["google/gemini-3.8-flash"]
    assert [turn["brainTurn"] for turn in report["brainTurns"]] == [1, 2]
    assert report["brainTurns"][0]["stagesMs"] == {
        "first_token_ttft": 1900,
        "total_turn": 2400,
        "before_first_llm_call": 5,
        "calls_before_first_word": 1,
        "llm_call_1_ttft": 650,
        "llm_call_1_duration": 700,
        "llm_call_2_ttft": 600,
        "llm_call_2_duration": 1200,
        "tool_search_style": 400,
    }
    assert report["brainStagesMs"]["llm_call_1_ttft"] == {"count": 2, "p50": 775.0, "p95": 887.5, "max": 900}
    assert report["brainStagesMs"]["llm_call_2_ttft"]["count"] == 1


def test_voice_latency_report_joins_spoken_replies_to_eve_turns_and_excludes_noisy_turns():
    def voice(payload):
        return f"agent | [voice-latency] {json.dumps(payload)}\n"

    def brain(payload):
        return f"eve | [brain-trace] {json.dumps(payload)}\n"

    step = lambda ttft: [{"stepIndex": 1, "start_ms": 40, "ttft_ms": ttft, "duration_ms": ttft + 200}]
    lines = [
        brain({"sessionId": "s1", "model": "google/gemini-3.8-flash", "started_at_ms": 1010, "status": "session.waiting", "input_kind": "opening", "first_token_ttft_ms": 900, "llm_steps": step(860)}),
        voice({"sessionId": "s1", "turnIndex": 0, "role": "assistant", "messageId": "a0", "createdAtMs": 1000, "loggedAtMs": 4000, "llmTtftMs": 1000, "ttsTtfbMs": 150, "e2eLatencyMs": 1300}),
        voice({"sessionId": "s1", "turnIndex": 1, "role": "user", "messageId": "u1", "createdAtMs": 9490, "transcriptionDelayMs": 100, "endOfTurnDelayMs": 400}),
        brain({"sessionId": "s1", "model": "google/gemini-3.8-flash", "started_at_ms": 9530, "status": "session.waiting", "input_kind": "learner", "first_token_ttft_ms": 1500, "llm_steps": step(1460),
               "eve_overhead_ms": {"resolve_session": 12}}),
        voice({"sessionId": "s1", "turnIndex": 1, "role": "assistant", "messageId": "a1", "createdAtMs": 9500, "loggedAtMs": 13000, "llmTtftMs": 1620, "ttsTtfbMs": 200, "e2eLatencyMs": 2300}),
        voice({"sessionId": "s1", "turnIndex": 2, "role": "user", "messageId": "u2", "createdAtMs": 20390, "transcriptionDelayMs": 90, "endOfTurnDelayMs": 380}),
        brain({"sessionId": "s1", "model": "google/gemini-3.8-flash", "started_at_ms": 20400, "status": "turn.cancelled", "input_kind": "learner", "first_token_ttft_ms": 5000, "llm_steps": step(4960)}),
        voice({"sessionId": "s1", "turnIndex": 2, "role": "assistant", "messageId": "a2", "createdAtMs": 20395, "loggedAtMs": 26000, "interrupted": True, "llmTtftMs": 5100, "e2eLatencyMs": 6000}),
    ]

    lines.insert(2, lines[1])  # agent logging duplicates records; the duplicate must not add a turn
    report = summarize(parse_events(lines), label="eve", brain_traces=parse_brain_traces(lines))

    assert [(t["turnIndex"], t.get("brainInputKind"), t["interrupted"]) for t in report["turns"]] == [
        (0, "opening", False),
        (1, "learner", False),
        (2, "learner", True),
    ]
    learner = report["turns"][1]
    assert learner["endOfTurnDelayMs"] == 400
    assert learner["transportOverheadMs"] == 120.0
    assert learner["brainStagesMs"]["eve_resolve_session"] == 12
    assert report["cleanJoinedTurnCount"] == 2
    assert report["turnBreakdownMs"]["e2eLatencyMs"]["max"] == 2300
    assert report["turnBreakdownMs"]["brain.first_token_ttft"]["max"] == 1500
    assert report["brainStagesMs"]["first_token_ttft"]["count"] == 2


def test_voice_latency_report_reads_eve_dev_log_json_lines():
    trace = {"sessionId": "s1", "started_at_ms": 1, "status": "session.waiting", "first_token_ttft_ms": 2607}
    line = json.dumps({"at": "2026-10-13T10:30:01.670Z", "source": "stdout", "detail": "[brain-trace] " + json.dumps(trace)})

    assert parse_brain_traces([line + "\n"]) == [trace]
