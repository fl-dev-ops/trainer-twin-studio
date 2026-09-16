"""Stable trainer-facing projection of DeepEval simulation output."""

from __future__ import annotations

from datetime import UTC, datetime


def _metric(metrics: list[dict], prefix: str) -> dict | None:
    return next((metric for metric in metrics if metric.get("name", "").startswith(prefix)), None)


def _mean(values: list[float | None]) -> float | None:
    present = [value for value in values if value is not None]
    return sum(present) / len(present) if present else None


def _decision_adherence(records: list[dict], policy: dict) -> tuple[int, int]:
    matched = 0
    for record in records:
        if policy.get(record.get("learnerState")) == record.get("move"):
            matched += 1
    return matched, len(records)


def build_fidelity_report(
    result: dict,
    cases: list,
    scenarios: list[dict],
    *,
    org_id: str,
    evaluation_model: str,
    threshold: float,
) -> dict:
    results = {item["name"]: item for item in result.get("test_results", [])}
    cases_by_name = {case.name: case for case in cases}
    scenario_reports = []

    for scenario in scenarios:
        runs = []
        persona = scenario.get("persona") if isinstance(scenario.get("persona"), dict) else {}
        decision_policy = persona.get("decision_preferences") if isinstance(persona.get("decision_preferences"), dict) else {}
        prefix = f'{scenario["slug"]}--'
        for name, item in results.items():
            if not name.startswith(prefix):
                continue
            case = cases_by_name.get(name)
            metadata = case.metadata if case else {}
            metrics = item.get("metrics_data", [])
            fidelity = _metric(metrics, "Trainer Fidelity")
            completeness = _metric(metrics, "Conversation Completeness")
            adherence = _metric(metrics, "Role Adherence")
            quality_score = _mean([
                completeness.get("score") if completeness else None,
                adherence.get("score") if adherence else None,
            ])
            decision_records = metadata.get("decision_records", [])
            decision_matches, recorded_decisions = _decision_adherence(decision_records, decision_policy)
            learner_turns = sum(turn.role == "user" for turn in (case.turns if case else []))
            decision_count = max(learner_turns, recorded_decisions)
            runs.append({
                "runId": metadata.get("session_id", name),
                "learner": {
                    "name": metadata.get("learner", name.removeprefix(prefix)),
                    "source": metadata.get("learner_source"),
                },
                "personaFidelity": {
                    "score": fidelity.get("score") if fidelity else None,
                    "reason": fidelity.get("reason") if fidelity else None,
                },
                "sessionQuality": {
                    "score": quality_score,
                    "completeness": completeness.get("score") if completeness else None,
                    "roleAdherence": adherence.get("score") if adherence else None,
                },
                "knowledgeSearches": metadata.get("knowledge_searches", []),
                "knowledgeRetrievals": metadata.get("knowledge_retrievals", []),
                "knowledgeTrackingAvailable": "knowledge_searches" in metadata,
                "decisionRecords": decision_records,
                "decisionMatches": decision_matches,
                "decisionEvaluatedCount": recorded_decisions,
                "decisionCount": decision_count,
                "decisionAdherence": decision_matches / decision_count if decision_count else None,
                "qualityIssues": metadata.get("quality_issues", []),
                "likeness": metadata.get("likeness", {}),
                "referenceSources": metadata.get("reference_sources", []),
                "turns": [
                    {"role": turn.role, "content": turn.content}
                    for turn in (case.turns if case else [])
                ],
            })

        runs.sort(key=lambda run: run["learner"]["name"])
        fidelity_score = _mean([run["personaFidelity"]["score"] for run in runs])
        quality_score = _mean([run["sessionQuality"]["score"] for run in runs])
        decision_matches = sum(run["decisionMatches"] for run in runs)
        decision_evaluated_count = sum(run["decisionEvaluatedCount"] for run in runs)
        decision_count = sum(run["decisionCount"] for run in runs)
        scenario_reports.append({
            "slug": scenario["slug"],
            "name": scenario["name"],
            "version": scenario.get("agent_version"),
            "persona": {
                "slug": scenario["persona_slug"],
                "name": scenario["persona_name"],
                "version": scenario.get("persona_version"),
            },
            "expectedRuns": 5,
            "personaFidelity": fidelity_score,
            "sessionQuality": quality_score,
            "decisionAdherence": decision_matches / decision_count if decision_count else None,
            "decisionMatches": decision_matches,
            "decisionEvaluatedCount": decision_evaluated_count,
            "decisionCount": decision_count,
            "knowledgeRetrievalRuns": sum(bool(run["knowledgeSearches"]) for run in runs),
            "knowledgeSearchCount": sum(len(run["knowledgeSearches"]) for run in runs),
            "knowledgeTrackedRuns": sum(run["knowledgeTrackingAvailable"] for run in runs),
            "runs": runs,
        })

    return {
        "schemaVersion": 1,
        "kind": "scenario-fidelity-report",
        "source": "simulation",
        "orgId": org_id,
        "createdAt": datetime.now(UTC).isoformat(),
        "evaluationModel": evaluation_model,
        "threshold": threshold,
        "summary": {
            "personaFidelity": _mean([scenario["personaFidelity"] for scenario in scenario_reports]),
            "sessionQuality": _mean([scenario["sessionQuality"] for scenario in scenario_reports]),
            "completedRuns": sum(len(scenario["runs"]) for scenario in scenario_reports),
            "expectedRuns": sum(scenario["expectedRuns"] for scenario in scenario_reports),
            "knowledgeRetrievalRuns": sum(scenario["knowledgeRetrievalRuns"] for scenario in scenario_reports),
            "knowledgeSearchCount": sum(scenario["knowledgeSearchCount"] for scenario in scenario_reports),
            "knowledgeTrackedRuns": sum(scenario["knowledgeTrackedRuns"] for scenario in scenario_reports),
        },
        "scenarios": scenario_reports,
    }
