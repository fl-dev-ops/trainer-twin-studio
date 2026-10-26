/**
 * Full-session strategy bake-off.
 *
 * Runs every strategy through complete multi-turn conversations (2 sessions x 8
 * learner turns), with REAL vector retrieval per turn (Chroma persona voice
 * moments), responses fed back into the transcript, a per-turn judge, and a
 * session-level judge for arc/looping/coverage.
 *
 * Run: bun run scripts/session-bakeoff.ts [strategyKeys...]
 */

import fs from "node:fs";
import { db } from "../lib/db";
import { MainCollectionService } from "../lib/main-collection";
import {
  type Scenario, type Turn, STRATEGIES, SPECS, judge, metrics, initRuntimeState,
  type Metrics, type StrategyResult,
} from "./bakeoff-lib";

const persona = await db.persona.findFirst({ where: { slug: { contains: "asanth" } }, select: { id: true, orgId: true } });
if (!persona) throw new Error("no vasanth persona in db");
const ORG_ID: string = persona.orgId!;
const PERSONA_ID: string = persona.id;

const SESSION_TRUTH = "GROUND TRUTH: no resume or document was uploaded for this session.";

// Two full conversations. Turn 1 learner = "" means the trainer must open.
type Session = { name: string; truth: string; turns: string[] };
const SESSIONS: Session[] = [
  {
    name: "A_resume_arc",
    truth: SESSION_TRUTH,
    turns: [
      "",
      "Do you have access to my resume?",
      "Can you tell me what you actually see in the resume so I can confirm it's mine?",
      "Can you tell me my name?",
      "Okay fine, let me just describe. I built an idempotency layer for our payments service using Redis, and I led the migration off SQS.",
      "The Redis keying was mine end to end — retries, envelope, the dedupe window.",
      "Honestly the biggest limitation was cold start; we never fully solved the thundering herd on reconnects.",
      "That's about it, I think. Anything else you want to know?",
    ],
  },
  {
    name: "B_pressure_arc",
    truth: SESSION_TRUTH,
    turns: [
      "",
      "Hey sorry, my connection was bad — can you repeat what you asked?",
      "Sure. In my last role I designed the notification pipeline. Kafka based, roughly two million events a day.",
      "The throughput was good, I don't remember the exact numbers.",
      "You know what, can we skip to system design instead? I'm much stronger there.",
      "Alright, continuing anyway: the consumer group rebalancing was the tricky part. I wrote the partition assignment logic myself.",
      "Why does that even matter for your evaluation though?",
      "I think that covers my experience.",
    ],
  },
];

async function retrieveMoments(pending: string, learner: string) {
  const query = `learner_state: responding\naction: probe\npending_question: ${pending}\nlast_learner: ${learner.slice(0, 300)}`;
  try {
    return await MainCollectionService.searchPersonaVoice(ORG_ID, query, { personaId: PERSONA_ID, limit: 6 });
  } catch (error) {
    console.error("retrieval failed:", String(error).slice(0, 120));
    return [];
  }
}

async function rawRetrieve(query: string, limit = 4) {
  try {
    return await MainCollectionService.searchPersonaVoice(ORG_ID, query, { personaId: PERSONA_ID, limit });
  } catch (error) {
    console.error("retrieval failed:", String(error).slice(0, 120));
    return [];
  }
}
// ---------- judges ----------

async function judgeSession(session: Session, transcript: Turn[], m: Metrics): Promise<Record<string, number>> {
  const raw = await llm(m, "session_judge", [
    { role: "system", content: `You are judging a COMPLETE mock-interview conversation between a trainer and a candidate.
${session.truth}
Score 1-5 each:
- flow: natural conversational arc (greeting, orientation, kick-off, progression) — does it feel like a real human ran this session?
- looping: does the trainer repeat/paraphrase the same ask instead of advancing? (5 = never stuck)
- side_handling: how were the candidate's side/meta questions handled (answered honestly and gracefully)?
- coverage: did the session make real progress on its objective despite the detours?
- voice_consistency: one coherent trainer voice throughout.
5 = excellent. ${session.truth}` },
    { role: "user", content: `Objective: ${SPECS.agent.objective}\nFull transcript:\n${transcript.map((t) => `${t.role === "trainer" ? "Trainer" : "Learner"}: ${t.text}`).join("\n")}\nReturn JSON only: {"flow":n,"looping":n,"side_handling":n,"coverage":n,"voice_consistency":n,"overall":n,"why":"2 sentences max"}` },
  ], { json: true });

  try {
    const j = JSON.parse(raw);
    return { flow: +j.flow || 0, looping: +j.looping || 0, side_handling: +j.side_handling || 0, coverage: +j.coverage || 0, voice_consistency: +j.voice_consistency || 0, overall: +j.overall || 0, why: j.why ?? "" };
  } catch {
    return { flow: 0, looping: 0, side_handling: 0, coverage: 0, voice_consistency: 0, overall: 0, why: "unparseable" } as any;
  }
}

async function main() {
  const keys = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(STRATEGIES);
  const results: any[] = [];
  for (const key of keys) {
    for (const session of SESSIONS) {
      const transcript: Turn[] = [];
      let pending = "";
      const turnRows: any[] = [];
      const sessionMetrics = metrics();
      for (let i = 0; i < session.turns.length; i++) {
        const learner = session.turns[i];
        const scenario: Scenario = { name: `${session.name}#t${i + 1}`, prior: [...transcript], learner, pendingQuestion: pending || undefined };
        let moments: { text: string }[] = [];
        if (i > 0) {
          moments = await retrieveMoments(pending, learner);
        }
        const state = initRuntimeState();
        const m = metrics();
        let out: StrategyResult;
        try {
          out = await STRATEGIES[key]({ scenario, state, learner, history: transcript, moments, retrieve: rawRetrieve }, m);
        } catch (error) {
          console.error(`FAIL ${key} ${session.name} t${i + 1}: ${String(error).slice(0, 150)}`);
          break;
        }
        sessionMetrics.criticalCalls += m.criticalCalls;
        sessionMetrics.criticalMs += m.criticalMs;
        sessionMetrics.backgroundMs += m.backgroundMs;
        transcript.push({ role: "learner", text: learner });
        transcript.push({ role: "trainer", text: out.text });
        pending = out.text; // bookkeeping: last trainer utterance is the pending ask
        const jm = metrics();
        let judgeOut: Record<string, number> = {};
        try { judgeOut = await judge(scenario, out.text, jm) as any; } catch { judgeOut = { overall: 0 }; }
        turnRows.push({ turn: i + 1, overall: judgeOut.overall ?? 0, response: out.text.slice(0, 260), decision: out.decision ?? null, calls: m.criticalCalls, ms: m.criticalMs });
        console.log(`${key.padEnd(26)} ${session.name} t${i + 1} ovr=${judgeOut.overall} calls=${m.criticalCalls} ms=${m.criticalMs}`);
      }
      const sm = metrics();
      const sessionJudge = await judgeSession(session, transcript, sm);
      results.push({ strategy: key, session: session.name, turns: turnRows, transcript: transcript.map((t) => `${t.role}: ${t.text}`), sessionJudge, totals: { turns: turnRows.length, calls: sessionMetrics.criticalCalls, criticalMs: sessionMetrics.criticalMs, backgroundMs: sessionMetrics.backgroundMs } });
      console.log(`>> ${key} ${session.name}: sessionJudge=${sessionJudge.overall} turns=${turnRows.length} calls=${sessionMetrics.criticalCalls}`);
    }
  }
  fs.writeFileSync("/tmp/session-bakeoff-results.json", JSON.stringify(results, null, 2));

  console.log("\n=== SESSION SUMMARY ===");
  console.log("strategy".padEnd(26), "session", "turnAvg", "flow", "loop", "side", "cover", "voice", "sessOvr", "calls", "critMs");
  for (const r of results) {
    const tAvg = (r.turns.reduce((s: number, t: any) => s + t.overall, 0) / Math.max(r.turns.length, 1)).toFixed(2);
    const j = r.sessionJudge;
    console.log(r.strategy.padEnd(26), r.session.padEnd(14), tAvg, j.flow, j.looping, j.side_handling, j.coverage, j.voice_consistency, j.overall, r.totals.calls, r.totals.criticalMs);
  }
  process.exit(0);
}

await main();
