import unittest

import httpx

from checks import conversation_likeness, conversation_quality_issues
from learners import all_learners, create_synthetic_learner_persona, document_grounded_learner
from scenarios import build_reference_context
from simulate import OpenRouterLLM, build_golden, evaluate_decisions, knowledge_searches, trainer_closed


class BenchmarkDataTest(unittest.TestCase):
    def test_golden_uses_source_grounded_trainer_context(self):
        sources = [{
            "name": "trainer-session.yaml",
            "kind": "transcript",
            "analysis": {
                "tone_description": "Direct and supportive",
                "habits": ["Asks one focused follow-up"],
                "conversation_moments": [
                    {"candidate_context": "I used caching", "interviewer_response": "Why was caching needed?"}
                ] * 12,
                "irrelevant": "excluded",
            },
        }]
        scenario = {
            "slug": "fundamentals",
            "name": "Fundamentals",
            "agent": {"objective": "Test depth", "config": {"scenario": {}}, "stages": []},
            "reference_persona_slug": "trainer",
            "sources": sources,
        }

        golden = build_golden(scenario)
        context = build_reference_context(sources)

        self.assertIsNone(golden.context)
        self.assertIn("Direct and supportive", context[0])
        self.assertNotIn("irrelevant", context[0])
        self.assertEqual(context[0].count("candidate_context"), 10)

    def test_quality_checks_catch_invented_mentions_and_duplicates(self):
        issues = conversation_quality_issues([
            {"role": "assistant", "content": "Pick one technology and explain a concept."},
            {"role": "user", "content": "I work with Node.js event loops."},
            {"role": "assistant", "content": "You mentioned managing a team project. What trade-offs did you make?"},
        ])
        self.assertIn("invented mention", issues)

        repeat = conversation_quality_issues([
            {"role": "assistant", "content": "Pick one technology and explain a concept."},
            {"role": "user", "content": "Sorry, can you repeat your question?"},
            {"role": "assistant", "content": "Pick one technology and explain a concept."},
        ])
        self.assertEqual(repeat, [])

    def test_likeness_scores_fillers_and_leaks(self):
        generic = conversation_likeness([
            {"role": "assistant", "content": "That's helpful. Can you clarify the daily active user count?"},
            {"role": "user", "content": "About one million DAU."},
            {"role": "assistant", "content": "Could you explain technology reasoning in your own words?"},
        ])
        self.assertEqual(generic["filler_rate"], 0)
        self.assertGreaterEqual(generic["label_leaks"], 1)

        vasanth = conversation_likeness([
            {"role": "assistant", "content": "Good, good. Can I know something about you — whatever you wish to share?"},
            {"role": "user", "content": "I have four years as a full stack developer."},
            {"role": "assistant", "content": "Got it, got it. Four years full stack. Correct? So now tell me, what is hoisting in JavaScript?"},
        ])
        self.assertGreater(vasanth["filler_rate"], 0.3)
        self.assertGreater(vasanth["restate_rate"], 0.3)
        self.assertEqual(vasanth["label_leaks"], 0)

    def test_trainer_closing_stops_goodbye_loops(self):
        self.assertTrue(trainer_closed("Thank you. Have a great day ahead!"))
        self.assertTrue(trainer_closed("Goodbye, take care!"))
        self.assertFalse(trainer_closed("Overall, how was your interview experience today?"))

    def test_file_session_learner_uses_document_identity(self):
        learner = document_grounded_learner("Surya", "resume.pdf", "Built TrainerTwin.")
        self.assertEqual(learner["name"], "Surya")
        self.assertIn("Built TrainerTwin", learner["characteristics"])
        self.assertNotIn("Anubhav", learner["characteristics"])

    def test_empty_openrouter_content_is_rejected_for_retry(self):
        response = httpx.Response(
            200,
            json={"choices": [{"message": {"content": None}}]},
            request=httpx.Request("POST", "https://openrouter.ai/api/v1/chat/completions"),
        )
        with self.assertRaises(ValueError):
            OpenRouterLLM._parse(response)

    def test_synthetic_learner_persona_avoids_static_overfitting(self):
        learners = all_learners()
        self.assertEqual([item["name"] for item in learners], ["Anubhav", "Deepak", "Saurabh", "Nikita", "Sushil"])
        persona = create_synthetic_learner_persona("Anubhav")
        self.assertEqual(persona.name, "Anubhav")
        self.assertIn("Do not copy any real transcript wording", persona.characteristics)
        golden = build_golden({
            "slug": "fundamentals",
            "name": "Fundamentals",
            "agent": {"objective": "Test depth", "config": {"scenario": {}}, "stages": []},
            "reference_persona_slug": "trainer",
            "sources": [],
        }, learners[1])
        self.assertEqual(golden.name, "fundamentals--deepak")

    def test_knowledge_searches_filters_internal_tool_calls(self):
        calls = [
            {"name": "search_style", "input": {"query": "hesitation"}},
            {"name": "search_knowledge", "input": {"query": "event loop", "topics": ["javascript"]}},
        ]

        self.assertEqual(knowledge_searches(calls), [calls[1]])

    def test_decision_evaluation_skips_missing_policy(self):
        self.assertEqual(evaluate_decisions([], {}, None), [])

if __name__ == "__main__":
    unittest.main()
