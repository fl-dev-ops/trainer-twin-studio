"""Offline regression tests for the SAME InterviewSession used by bot.py.

Only web/provider I/O is replaced. Real Studio YAML, compiler, Pydantic AI
structured-output handling, controller, renderer validation and SQLite are used.
"""
import asyncio
from copy import deepcopy
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

import yaml
from pydantic_ai import UnexpectedModelBehavior
from pydantic_ai.messages import ModelResponse, TextPart
from pydantic_ai.models.function import FunctionModel

import interview
from interview import InterviewSession, build_specs
from runner import AnswerAnalysis, EvidenceUpdate, active_phase, active_scenario, validate_analysis

DATA = Path(__file__).resolve().parent.parent / "web/data"


def config_for(agent="full-mock-interview", persona="vasanth"):
    a = yaml.safe_load((DATA / "agents" / f"{agent}.yaml").read_text())["agent"]
    p = yaml.safe_load((DATA / "personas" / f"{persona}.yaml").read_text())["persona"]
    d = yaml.safe_load((DATA / "domains" / f"{a['domain']}.yaml").read_text())["domain"]
    return {
        **{k: {"version": v["version"], "data": v} for k, v in (("persona", p), ("agent", a), ("domain", d))},
        "knowledgeBases": [],
        "session": {"id": "session-test", "orgId": "org-test", "userId": "user-test"},
    }


class CompilerTests(unittest.TestCase):
    def test_every_existing_studio_persona_and_scenario_compiles(self):
        for p in (DATA / "personas").glob("*.yaml"):
            for a in (DATA / "agents").glob("*.yaml"):
                with self.subTest(persona=p.stem, agent=a.stem):
                    config = config_for(a.stem, p.stem)
                    persona, agent, domain, kbs = build_specs(config)
                    self.assertEqual(persona.style, config["persona"]["data"]["style"])
                    self.assertEqual(persona.examples, config["persona"]["data"].get("examples", {}))
                    for source, phase in zip(config["agent"]["data"]["stages"], agent.phases):
                        self.assertEqual(phase.max_learner_turns, source["config"]["turns"]["maximum"])
                        self.assertEqual(len(phase.evidence_keys), len(source["config"]["evidence"]["keys"]))
                        self.assertEqual(phase.claim_handling, source["config"]["claim_handling"])

    def test_overrides_keep_hidden_scenario_facts_and_tools(self):
        _, agent, _, _ = build_specs(config_for("real-world-system-design"))
        self.assertEqual(active_scenario(agent, {"phase_index": 0})["hidden_requirements"]["file_size"], "Files can be as large as 20 GB.")
        _, full, _, _ = build_specs(config_for())
        self.assertEqual(full.phases[2].tools[0]["id"], "coding_sandbox")
        self.assertFalse(full.phases[-1].retrieval)
        self.assertIn(full.phases[2].default_action, full.phases[2].allowed_actions)

    def test_bad_configs_rejected_and_versions_come_from_database(self):
        original = config_for("fundamentals-depth")
        for mutate in (lambda c: c["agent"]["data"]["stages"].clear(),
                       lambda c: c["agent"]["data"]["stages"][0]["config"]["evidence"]["completion_keys"].append("fake"),
                       lambda c: c["agent"]["data"]["stages"][0]["config"]["turns"].update(maximum=-1)):
            c = deepcopy(original)
            mutate(c)
            with self.assertRaises(ValueError):
                build_specs(c)
        original["persona"]["version"] = 9
        self.assertEqual(build_specs(original)[0].version, 9)

    def test_remote_context_is_literal_not_a_file_read(self):
        with tempfile.NamedTemporaryFile(mode="w") as f:
            f.write("PRIVATE CONTENT")
            f.flush()
            self.assertEqual(interview.extract_context_text({"content": f.name}), f.name)


class LiveSessionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db_path = Path(self.tmp.name) / "sessions.db"
        self.db_patch = patch.object(interview, "DB_PATH", self.db_path)
        self.db_patch.start()
        self.addCleanup(self.db_patch.stop)
        self.config = config_for()
        self.config["context"] = {"id": "context-test", "name": "resume.txt", "content": "SECRET_RESUME: a learner project."}
        self.prompts = []
        self.intent, self.classification, self.status = "answer", "strong", "sufficient"
        self.latest = "My example explains the underlying reasoning."
        self.entered = asyncio.Event()
        self.block_render = False
        self.invalid_render = False
        self.fail_model = False
        self.transient_failures = 0
        self.unresolved_point = ""

        async def respond(messages, info):
            prompt = "\n".join(p.content for m in messages for p in m.parts if isinstance(getattr(p, "content", None), str))
            self.prompts.append(prompt)
            if self.fail_model:
                raise RuntimeError("provider unavailable")
            if self.transient_failures:
                self.transient_failures -= 1
                raise UnexpectedModelBehavior("provider returned finish_reason error")
            if info.model_request_parameters.output_mode == "native":
                phase = active_phase(self.session._agent, self.session.state)
                updates = [] if self.intent != "answer" or self.status is None else [
                    {"key": k, "status": self.status, "quote": self.latest,
                     "evidence": "Reasoned answer for the active criterion", "provenance": "supported_elaboration"}
                    for k in phase.evidence_keys
                    if self.session.state["coverage"][k] != "sufficient"
                ][:2]
                return ModelResponse(parts=[TextPart(json.dumps({
                    "classification": self.classification, "learner_intent": self.intent,
                    "evidence_updates": updates, "valid_evidence": [self.latest],
                    "unresolved_point": self.unresolved_point,
                }))])
            if self.block_render:
                self.entered.set()
                await asyncio.Future()
            text = "Explain this? And that?" if self.invalid_render else "You described the reasoning. What changes in your example?"
            return ModelResponse(parts=[TextPart(text)])

        self.model = FunctionModel(respond)
        self.model_patch = patch.object(interview, "make_model", return_value=self.model)
        self.model_patch.start()
        self.addCleanup(self.model_patch.stop)
        self.fetch_patch = patch.object(interview, "fetch_config", side_effect=lambda *args: deepcopy(self.config))
        self.fetch_patch.start()
        self.addCleanup(self.fetch_patch.stop)
        self.session = InterviewSession()

    async def start(self):
        return await self.session.start("session-test", "runtime-token")

    def rows(self):
        with sqlite3.connect(self.db_path) as con:
            return con.execute("SELECT role,text FROM turns ORDER BY turn_index").fetchall()

    async def test_full_web_scenario_progresses_and_closes_with_persisted_evidence(self):
        await self.start()
        phases = {0}
        for _ in range(self.session._agent.max_learner_turns):
            reply = await self.session.step(self.latest)
            phases.add(self.session.state["phase_index"])
            if self.session.closed:
                break
        self.assertTrue(self.session.closed)
        self.assertEqual(phases, {0, 1, 2, 3, 4})
        self.assertNotIn("?", reply)
        self.assertTrue(self.session.state["evidence"])
        self.assertIn("present_feedback", self.session.state["actions"])
        self.assertEqual(self.session.surface_for_phase(2)["action"], "open_code_editor")
        self.assertIsNone(self.session.surface_for_phase(4))
        self.assertNotEqual(self.session.state["coverage"]["coding.execution_result"], "sufficient")
        with sqlite3.connect(self.db_path) as con:
            status, state = con.execute("SELECT status,state_json FROM sessions").fetchone()
            self.assertEqual(status, "completed")
            self.assertEqual(json.loads(state), self.session.state)
            self.assertEqual(con.execute("SELECT count(*) FROM decisions").fetchone()[0], self.session.state["learner_turns"])
        self.assertEqual(len(self.rows()), 1 + 2 * self.session.state["learner_turns"])

    async def test_persona_and_context_rules_reinjected_on_each_model_call(self):
        await self.start()
        await self.session.step(self.latest)
        analyze_prompt, render_prompt = self.prompts[-2:]
        self.assertIn("SECRET_RESUME", analyze_prompt)
        self.assertIn("Briefly acknowledge valid evidence", render_prompt)
        self.assertIn("Paraphrase important claims", render_prompt)
        self.assertIn("What simpler option existed", render_prompt)
        self.assertNotIn("Start with the question directly", render_prompt)
        self.session.state["phase_index"] = 3  # hypothetical_design: no learner documents in prompt
        await self.session.step(self.latest)
        self.assertNotIn("SECRET_RESUME", self.prompts[-2])
        self.assertIn("Briefly acknowledge valid evidence", self.prompts[-1])

    async def test_live_render_uses_retrieved_persona_source_moments(self):
        self.config["personaVoiceAvailable"] = True
        await self.start()
        self.session._persona_voice.query = AsyncMock(return_value=[{
            "text": "Candidate: We improved conversion.\nAction: request_justification\nInterviewer: How did you measure that?",
            "source": "interview.yaml",
        }])
        await self.session.step(self.latest)
        self.assertIn("How did you measure that?", self.prompts[-1])
        self.session._persona_voice.query.assert_awaited_once()

    async def test_transition_clears_previous_stage_focus_before_rendering(self):
        stage = self.config["agent"]["data"]["stages"][0]["config"]["turns"]
        stage.update(minimum=1, maximum=1)
        self.unresolved_point = "OLD_STAGE_GAP"
        await self.start()
        await self.session.step(self.latest)
        self.assertEqual(self.session.state["phase_index"], 1)
        self.assertEqual(self.session.state["focus"]["unresolved_point"], "")
        self.assertNotIn("OLD_STAGE_GAP", self.prompts[-1])

    async def test_clarification_does_not_grade_or_spend_probe_budget(self):
        await self.start()
        self.intent = "clarification"
        before = deepcopy(self.session.state)
        await self.session.step("Could you explain what you mean?")
        self.assertEqual(self.session.state["coverage"], before["coverage"])
        self.assertEqual(self.session.state["evidence_probe_counts"], before["evidence_probe_counts"])
        self.assertEqual(self.session.state["phase_index"], 0)
        self.assertIn("Respond to the learner's actual question", self.prompts[-1])

    async def test_provider_failure_and_cancel_during_render_commit_nothing(self):
        await self.start()
        before, rows = deepcopy(self.session.state), self.rows()
        self.fail_model = True
        with self.assertRaises(RuntimeError):
            await self.session.step(self.latest)
        self.fail_model = False
        self.block_render = True
        task = asyncio.create_task(self.session.step(self.latest))
        await asyncio.wait_for(self.entered.wait(), 2)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(self.session.state, before)
        self.assertEqual(self.rows(), rows)
        self.block_render = False
        await self.session.step(self.latest)
        self.assertEqual(self.session.state["learner_turns"], 1)

    async def test_transient_provider_failure_retries_without_duplicate_turn(self):
        await self.start()
        self.transient_failures = 1
        await self.session.step(self.latest)
        self.assertEqual(self.session.state["learner_turns"], 1)
        self.assertEqual(len(self.rows()), 3)

    async def test_write_failure_rolls_back_whole_turn(self):
        await self.start()
        before, rows = deepcopy(self.session.state), self.rows()
        with patch.object(interview.sqlite3, "connect", side_effect=sqlite3.OperationalError("disk unavailable")):
            with self.assertRaises(sqlite3.OperationalError):
                await self.session.step(self.latest)
        self.assertEqual(self.rows(), rows)
        self.assertEqual(self.session.state, before)

    async def test_spec_total_limit_and_stop_close_without_extra_questions(self):
        self.config = config_for("fundamentals-depth")
        self.config["agent"]["data"]["config"]["turns"]["maximum"] = 1
        await self.start()
        reply = await self.session.step(self.latest)
        self.assertTrue(self.session.closed)
        self.assertNotIn("?", reply)
        self.assertTrue(any(v == "sufficient" for v in self.session.state["coverage"].values()))
        with self.assertRaises(RuntimeError):
            await self.session.step(self.latest)

    async def test_stop_does_not_call_model_or_award_evidence(self):
        await self.start()
        reply = await self.session.step("Please stop the session.")
        self.assertTrue(self.session.closed)
        self.assertEqual(self.prompts, [])
        self.assertFalse(self.session.state["evidence"])
        self.assertNotIn("?", reply)

    async def test_duplicate_start_serialized_and_identity_cannot_change(self):
        openings = await asyncio.gather(self.start(), self.start())
        self.assertEqual(openings[0], openings[1])
        self.assertEqual(len(self.rows()), 1)
        with self.assertRaises(RuntimeError):
            await self.session.start("someone-else", "another-scenario")

    async def test_non_technical_scenario_has_no_software_interviewer_identity(self):
        self.config = config_for("fundamentals-depth")
        self.config["domain"]["data"].update(name="Patient communication practice", id="communication",
            principles=["Listen respectfully before explaining."], classifications={"strong": "Acknowledges the speaker's concern"})
        a = self.config["agent"]["data"]
        a.update(domain="communication", objective="Practice respectful listening", opening="How would you acknowledge a worried person?")
        p = a["stages"][0]
        p.update(name="Listening", objective="Recognize the concern", opening="Invite their perspective.")
        p["config"]["evidence"] = {"definitions": {"listening": "An acknowledgment of the concern"}, "keys": ["listening"], "completion_keys": ["listening"]}
        await self.start()
        await self.session.step(self.latest)
        self.assertIn("Patient communication practice", self.prompts[-1])
        self.assertNotIn("expert technical interviewer", " ".join(self.prompts))

    async def test_retrieval_before_analysis_and_disabled_for_feedback(self):
        self.config["knowledgeBases"] = ["approved"]
        await self.start()
        self.session._knowledge.query = AsyncMock(return_value=[{"text": "REFERENCE_MARKER", "source": "lesson"}])
        await self.session.step(self.latest)
        self.assertIn("REFERENCE_MARKER", self.prompts[-2])
        self.assertIn("REFERENCE_MARKER", self.prompts[-1])
        self.session.state["phase_index"] = 4
        self.assertEqual(await self.session._references(self.session.state, "hello"), [])
        self.assertEqual(self.session._knowledge.query.await_count, 1)

    async def test_invalid_render_retries_then_uses_valid_fallback(self):
        await self.start()
        self.invalid_render = True
        reply = await self.session.step(self.latest)
        self.assertEqual(reply.count("?"), 1)
        self.assertEqual(len(self.prompts), 3)

    async def test_invalid_evidence_rejected_without_inventing_support(self):
        await self.start()
        key = active_phase(self.session._agent, self.session.state).evidence_keys[0]
        raw = AnswerAnalysis(classification="strong", evidence_updates=[EvidenceUpdate(key=key, status="sufficient", evidence="looks right", quote="invented quote")])
        analysis, corrections = validate_analysis(raw, self.session._agent, self.session.state, "actual answer")
        self.assertFalse(analysis.evidence_updates)
        self.assertTrue(corrections)


if __name__ == "__main__":
    unittest.main()
