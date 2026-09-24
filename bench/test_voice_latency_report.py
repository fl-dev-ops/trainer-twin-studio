from voice_latency_report import parse_events, percentile, summarize


def test_voice_latency_report_parses_mixed_logs_and_calculates_percentiles():
    lines = [
        "unrelated log\n",
        'agent | [voice-latency] {"sessionId":"s1","turnIndex":1,"role":"user","endOfTurnDelayMs":500,"transcriptionDelayMs":100,"sttProvider":"deepgram","sttModel":"flux"}\n',
        'agent | [voice-latency] {"sessionId":"s1","turnIndex":1,"role":"assistant","llmTtftMs":1000,"ttsTtfbMs":200,"e2eLatencyMs":1800,"llmProvider":"groq","llmModel":"gpt-oss","ttsProvider":"sarvam","ttsModel":"bulbul"}\n',
        'agent | [voice-latency] {"sessionId":"s2","turnIndex":1,"role":"assistant","llmTtftMs":3000,"ttsTtfbMs":400,"e2eLatencyMs":4200}\n',
        "agent | [voice-latency] not-json\n",
    ]

    events = parse_events(lines)
    report = summarize(events, label="baseline-v1")

    assert len(events) == 3
    assert percentile([1000, 3000], 0.5) == 2000
    assert report["sessionCount"] == 2
    assert report["turnCount"] == 2
    assert report["providers"] == ["deepgram/flux", "groq/gpt-oss", "sarvam/bulbul"]
    assert report["metricsMs"]["llmTtftMs"] == {
        "count": 2,
        "min": 1000,
        "p50": 2000.0,
        "p90": 2800.0,
        "p95": 2900.0,
        "max": 3000,
    }
