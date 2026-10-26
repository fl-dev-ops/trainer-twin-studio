/** Single-turn strategy bake-off runner (scenarios judged in isolation). */
import fs from "node:fs";
import {
  type Scenario, type Turn, STRATEGIES, judge, metrics, initRuntimeState, midSessionState, PENDING_Q, PENDING_EVIDENCE,
} from "./bakeoff-lib";

const SCENARIOS: Scenario[] = [
  { name: "S1 opening", prior: [] as Turn[], learner: "" },
  {
    name: "S2 good answer",
    prior: [{ role: "trainer", text: PENDING_Q }],
    learner: "I personally implemented the idempotency layer — the Redis keying and the retry envelope. The rest of the payments service was three of us, but that part was mine end to end.",
  },
  { name: "S3 side question", prior: [{ role: "trainer", text: PENDING_Q }], learner: "Quick question — do you actually have access to my resume right now?" },
  { name: "S4 meta question", prior: [{ role: "trainer", text: PENDING_Q }], learner: "Sorry, can you tell me your name and how this session works?" },
  { name: "S5 vague answer", prior: [{ role: "trainer", text: PENDING_Q }], learner: "Oh the payments service was a team effort, I touched a lot of it, mostly helped out here and there." },
  { name: "S6 redirect request", prior: [{ role: "trainer", text: PENDING_Q }], learner: "Honestly, can we skip ahead to the system design part? I'd rather do that." },
];

async function main() {
  const keys = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(STRATEGIES);
  const results: any[] = [];
  for (const key of keys) {
    for (const scenario of SCENARIOS) {
      const state = scenario.prior.length ? midSessionState() : initRuntimeState();
      const m = metrics();
      const started = performance.now();
      let out;
      try {
        out = await STRATEGIES[key]({ scenario, state, learner: scenario.learner, history: scenario.prior, moments: [] }, m);
      } catch (error) {
        results.push({ strategy: key, scenario: scenario.name, error: String(error).slice(0, 200) });
        console.error(`FAIL ${key} ${scenario.name}: ${error}`);
        continue;
      }
      m.wallMs = Math.round(performance.now() - started);
      const jm = metrics();
      let judgeOut: any = {};
      try { judgeOut = await judge(scenario, out.text, jm); }
      catch (error) { judgeOut = { overall: 0, why: `judge failed: ${String(error).slice(0, 100)}` }; }
      results.push({ strategy: key, scenario: scenario.name, response: out.text.slice(0, 300), decision: out.decision ?? null, criticalCalls: m.criticalCalls, criticalMs: m.criticalMs, backgroundMs: m.backgroundMs, ...judgeOut });
      console.log(`${key.padEnd(28)} ${scenario.name.padEnd(20)} overall=${judgeOut.overall} crit=${m.criticalCalls}calls/${m.criticalMs}ms`);
    }
  }
  fs.writeFileSync("/tmp/bakeoff-results.json", JSON.stringify(results, null, 2));
  console.log("done ->", results.length, "rows");
}

await main();
