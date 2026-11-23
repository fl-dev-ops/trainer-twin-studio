import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

/**
 * Role play written from a trainer's requirements (skill roleplay-creator, plans/roleplay-creator.md), against a real
 * model and a real studio. Each case sends real requirement text, lets the copilot draft, approves the publish, and has
 * a judge grade the brief it wrote against how good role plays are written (situation, roles, what the AI does, how).
 *
 * Needs: STUDIO_URL and SCENARIO_INGEST_SECRET (an isolated studio), EVAL_ORG_ID and EVAL_USER_ID (a studio member of an
 * org whose personas include the ones named below), and EVAL_REQUIREMENTS_DIR with the trainers' documents
 * (olga.md, coaches.md, vasanth.md). Cases whose document is missing are skipped. Run: eve eval roleplay-creator
 */

const dir = process.env.EVAL_REQUIREMENTS_DIR;
const doc = (name: string) => {
  try { return dir ? readFileSync(join(dir, name), "utf8") : null; } catch { return null; }
};
const headers = () => ({
  authorization: `Basic ${Buffer.from(`${process.env.EVAL_ORG_ID}:${process.env.COPILOT_SERVICE_SECRET}`).toString("base64")}`,
  "x-trainertwin-user-id": process.env.EVAL_USER_ID ?? "",
});

type Call = { name?: string; toolName?: string; input?: unknown; output?: unknown; status?: string };
const calls = (turns: { toolCalls?: unknown }[], name: string) =>
  turns.flatMap((turn) => (Array.isArray(turn.toolCalls) ? turn.toolCalls as Call[] : [])).filter((call) => (call.name ?? call.toolName) === name);
const ok = (call: Call) => (call.output as { ok?: unknown } | undefined)?.ok === true;

const QUALITY = [
  "Judge this role-play brief written for an AI that plays one side of a practice conversation. Score how well it follows these principles:",
  "1. The AI's instructions are written to \"you\" and say who the AI is IN THIS SITUATION and its relationship to the learner (not a personality description).",
  "2. The situation says what triggered the conversation, what the AI knows, how it feels at the start, and facts to keep consistent.",
  "3. The learner's role and aim are clear and outcome-based.",
  "4. Concerns are written as the character would see them, never with the answers; hidden ones are marked and not in the learner brief.",
  "5. The flow is a realistic conversation in a few steps, including deliberate moments the requirements ask for.",
  "6. Reactions are observable learner behaviours; resistance is reasonable and firm, not hostile.",
  "7. There is a clear ending: limit, what good looks like, exit line when relevant.",
  "8. It is faithful to the requirements (given in full) for the scenario and persona asked: no facts, backstory or lines borrowed from another persona or scenario, none invented; the requirement's details kept.",
].join("\n");

type Case = { id: string; file: string; ask: string; persona: string; expectNotes?: RegExp };
const cases: Case[] = [
  { id: "olga-first-call", file: "olga.md", persona: "Ravi Menon", ask: "Write Scenario 1 (first call after the ad) as one role play, played by the buyer Ravi Menon. Use his details exactly as written." },
  { id: "olga-objections", file: "olga.md", persona: "Faisal Al-Qahtani", ask: "Write Scenario 2 (after the presentation) as one role play, played by Faisal Al-Qahtani. Include the 35 objections so the buyer can draw on them." },
  { id: "bevan-missed-deadlines", file: "coaches.md", persona: "Chloe Martin", ask: "Write Bevan's Scenario 2 (missed deadlines) as one role play, played by Chloe Martin." },
  { id: "flo-keynote", file: "coaches.md", persona: "Ingrid Larsen", ask: "Write Flo's Scenario 3 (keynote Q&A) as one role play, played by Ingrid Larsen." },
  { id: "jameel-technical", file: "coaches.md", persona: "Linda Chen", ask: "Write Jameel's Scenario 2 (round two, technical) as one role play, played by Linda Chen.", expectNotes: /mode|practice|mock/i },
  { id: "daniele-design-review", file: "coaches.md", persona: "Martin Keller", ask: "Write Daniele's Scenario 2 (the design review) as one role play, played by Martin Keller." },
  { id: "vasanth-impact", file: "vasanth.md", persona: "Vasanth", ask: "Write Round 2 of Interview 1 (Impact & Quantification) as one mock-interview role play, played by Vasanth. The candidate attaches their résumé." },
];

const builds = cases.map((c) => defineEval({
  description: `Writes and publishes a role play from requirements: ${c.id}`,
  tags: ["roleplay-creator", "live"],
  async test(t) {
    const requirements = doc(c.file);
    if (!requirements || !process.env.EVAL_ORG_ID) return t.skip(`requirements ${c.file} or EVAL_ORG_ID not provided`);
    const first = await t.send(`<use-skill name="roleplay-creator" />\n${c.ask}\n\nThe requirements:\n\n${requirements}`, { headers: headers() });
    first.expectOk();
    const turns = [first];
    let session = first.session;
    // The copilot may ask for something it can't propose; answer once with "use your proposals".
    if (!calls(turns, "roleplay_draft").some(ok)) {
      const next = await session.send("Use your proposals for anything not in the requirements, and draft it.", { headers: headers() });
      turns.push(next);
      session = next.session;
    }
    const drafts = calls(turns, "roleplay_draft");
    t.log(`${c.id}: ${drafts.length} drafts; reasons ${JSON.stringify(drafts.map((d) => (d.output as { reasons?: unknown })?.reasons ?? []))}`);
    await t.require(drafts.some(ok), satisfies((value) => value === true, "a draft passed the studio's checks"));
    t.calledTool("persona_list");
    if (c.expectNotes) t.check(turns.map((turn) => turn.reply).join("\n"), satisfies((reply) => c.expectNotes!.test(String(reply)), "explains what the role play can't do yet"));

    const brief = drafts.filter(ok).at(-1)!.input as { brief: unknown };
    t.log(`${c.id}: reply: ${turns.at(-1)!.reply}`);
    t.log(`${c.id}: brief: ${JSON.stringify(brief.brief)}`);
    t.judge({ type: "score", instructions: QUALITY, criteria: ["Poor", "Weak", "Adequate", "Good", "Excellent"] }, { on: JSON.parse(JSON.stringify({ ask: c.ask, requirements, brief: brief.brief })) })
      .label("brief quality").atLeast(0.75);

    const publish = await session.send("This looks right. Publish it.", { headers: headers() });
    t.log(`${c.id}: publish turn ${publish.status}: ${publish.reply}; events: ${JSON.stringify(publish.events.filter((e) => /error|failed|interaction|approval/i.test(e.type)).slice(-5))}`);
    // Approve every pending request (the publish, and any settings change it proposes, e.g. a résumé upload).
    const pending = publish.interactions as readonly { interactionId: string; request: { prompt?: string } }[];
    t.check(pending.some((i) => /Publish the role play/.test(i.request.prompt ?? "")), satisfies((v) => v === true, "asks to publish"));
    t.log(`${c.id}: approvals: ${JSON.stringify(pending.map((i) => i.request.prompt))}`);
    const approved = await publish.session.respond(pending.map((i) => ({ interactionId: i.interactionId, optionId: "approve" })), { headers: headers() });
    t.log(`${c.id}: approved turn ${approved.status}: ${approved.reply}`);
    approved.expectOk();
    // The trainer sees what was drafted and what was published, in words.
    t.check(turns.at(-1)!.reply, satisfies((reply) => String(reply).trim().length > 40, "shows the trainer the draft"));
    t.check(approved.reply, satisfies((reply) => /publish|version|live|ready/i.test(String(reply)), "reports the publish"));
    t.calledTool("roleplay_publish", { output: (value: unknown) => (value as { ok?: unknown })?.ok === true, count: 1 });
    const published = calls([approved], "roleplay_publish").at(-1)?.output as { persona?: string } | undefined;
    t.log(`${c.id}: published ${JSON.stringify(published)}; expected persona ${c.persona}`);
  },
}));

const vague = defineEval({
  description: "A vague role-play request gets one message asking only for the essentials, and nothing is drafted yet.",
  tags: ["roleplay-creator", "live"],
  async test(t) {
    if (!process.env.EVAL_ORG_ID) return t.skip("EVAL_ORG_ID not provided");
    const turn = await t.send("<use-skill name=\"roleplay-creator\" />\nCan you make a role play for my team?", { headers: headers() });
    turn.expectOk();
    t.notCalledTool("roleplay_draft");
    t.notCalledTool("roleplay_publish");
    t.judge("The reply asks, in one message, for the essentials of the role play (who the AI plays, who the learner plays, the situation, what the learner should achieve) and does not ask about details it could propose itself.", { on: turn.reply }).atLeast(0.7);
  },
});

export default [...builds, vague];
