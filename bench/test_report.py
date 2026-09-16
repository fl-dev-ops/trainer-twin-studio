from types import SimpleNamespace

from report import build_fidelity_report


def test_build_fidelity_report_aggregates_one_scenario():
    case = SimpleNamespace(
        name="fundamental-knowledge--anubhav",
        metadata={
            "session_id": "session-1",
            "learner": "Anubhav",
            "learner_source": "01.yaml",
            "knowledge_searches": [{"name": "search_knowledge", "input": {"query": "event loop"}}],
            "knowledge_retrievals": [{
                "callId": "call-1",
                "input": {"query": "event loop"},
                "output": {"results": [{"chunkId": "chunk-1", "docId": "doc-1"}]},
            }],
            "decision_records": [
                {"turnIndex": 0, "learnerState": "partial_answer", "move": "narrow_hint", "reason": "Trainer supplied a focused hint."},
            ],
            "quality_issues": ["stacked questions"],
            "reference_sources": ["trainer.yaml"],
        },
        turns=[
            SimpleNamespace(role="user", content="It uses an event queue."),
            SimpleNamespace(role="assistant", content="Good, good. Why?"),
            SimpleNamespace(role="user", content="I am not sure."),
        ],
    )
    result = {"test_results": [{
        "name": case.name,
        "metrics_data": [
            {"name": "Trainer Fidelity [Conversational GEval]", "score": 0.8, "reason": "Matches probing style."},
            {"name": "Conversation Completeness", "score": 0.6},
            {"name": "Role Adherence", "score": 1.0},
        ],
    }]}
    scenario = {
        "slug": "fundamental-knowledge",
        "name": "Fundamental Knowledge",
        "persona_slug": "vasanth",
        "persona_name": "Vasanth",
        "agent_version": 2,
        "persona_version": 3,
        "persona": {"decision_preferences": {"partial_answer": "narrow_hint", "strong_answer": "deepen_with_tradeoff"}},
    }

    report = build_fidelity_report(
        result, [case], [scenario], org_id="org-1", evaluation_model="judge", threshold=0.7,
    )

    assert report["summary"]["personaFidelity"] == 0.8
    assert report["summary"]["sessionQuality"] == 0.8
    assert report["summary"]["knowledgeRetrievalRuns"] == 1
    assert report["summary"]["knowledgeTrackedRuns"] == 1
    assert report["scenarios"][0]["decisionAdherence"] == 0.5
    assert report["scenarios"][0]["decisionMatches"] == 1
    assert report["scenarios"][0]["decisionEvaluatedCount"] == 1
    assert report["scenarios"][0]["decisionCount"] == 2
    assert report["scenarios"][0]["runs"][0]["referenceSources"] == ["trainer.yaml"]
    assert report["scenarios"][0]["runs"][0]["knowledgeRetrievals"][0]["output"]["results"][0]["chunkId"] == "chunk-1"
