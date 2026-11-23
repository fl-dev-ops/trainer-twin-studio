import assert from "node:assert/strict";
import { defineEval } from "eve/evals";

/**
 * One realistic request per area skill (knowledge, twin, roleplay, persona, users) and one it can't do, against the
 * fixture studio web/scripts/check-copilot-persona.ts prepares. Tool calls are gates; loading the area skill is soft
 * (the model may answer a simple read without it), so the report shows how often each skill is actually used.
 * Run: cd web && DATABASE_URL=<*_test db> COPILOT_QA_EVAL=domain-skills bun scripts/check-copilot-persona.ts
 */
export default defineEval({
  description: "Each area skill: the right tools, one approval card per part, and a clear 'can't' line",
  tags: ["live", "skills"],
  async test(t) {
    const url = process.env.STUDIO_URL;
    const org = process.env.PERSONA_QA_ORG;
    const user = process.env.PERSONA_QA_USER;
    const phrase = process.env.PERSONA_QA_PHRASE;
    if (!url || !org || !user || !phrase) return t.skip("Run against a prepared local studio fixture");
    assert(["localhost", "127.0.0.1"].includes(new URL(url).hostname));
    assert(org.startsWith("persona-qa-"));
    const headers = { authorization: `Basic ${Buffer.from(`${org}:${process.env.COPILOT_SERVICE_SECRET}`).toString("base64")}`, "x-trainertwin-user-id": user };
    const confirm = "Those are the final details. Show me the approval card(s).";
    // The card may come on the first turn or after the copilot confirms; `said` is everything it wrote before the card.
    const pending = async (first: Awaited<ReturnType<typeof t.send>>) => {
      const turn = first.interactions.length ? first : await first.session.send(confirm, { headers });
      return Object.assign(turn, { said: [first.reply, turn === first ? "" : turn.reply].filter(Boolean).join("\n") });
    };
    const approveAll = (turn: Awaited<ReturnType<typeof t.send>>) =>
      turn.session.respond(turn.interactions.map((i) => ({ interactionId: i.interactionId, optionId: "approve" })), { headers });
    const prompts = (turn: { interactions: readonly { request: { prompt?: string } }[] }) => turn.interactions.map((i) => i.request.prompt ?? "");

    // knowledge
    const knowledge = await t.send("What does our Demo Playbook say to use as the fallback phrase when a demo isn't confirmed? Quote it.", { headers });
    knowledge.expectOk();
    knowledge.calledTool("knowledge_search"); // the hit itself carries the line, so a read is optional
    knowledge.calledSkill("knowledge").soft();
    assert((knowledge.reply ?? "").includes(phrase), `Expected the seeded phrase: ${knowledge.reply}`);

    // twin: settings only, never the details tool
    const twinAsk = await pending(await t.send("Turn on screen share for the Silver Compass twin skill. Nothing else.", { headers }));
    assert(prompts(twinAsk).some((p) => p.startsWith('Change twin "Silver Compass"') && /preScreenshare/.test(p)), `twin card: ${prompts(twinAsk)} | ${twinAsk.reply}`);
    const twin = await approveAll(twinAsk);
    twin.expectOk();
    twin.calledTool("twin_settings_update", { count: 1 });
    twin.notCalledTool("twin_update");
    twinAsk.calledSkill("twin").soft();

    // roleplay: an upload (Settings) and the PDF viewer (Tools) are two parts, two cards
    const rpAsk = await pending(await t.send("For the Orchard Follow-up role play, let learners upload their CV before the call and show it in the PDF viewer.", { headers }));
    const rpPrompts = prompts(rpAsk);
    assert(rpPrompts.some((p) => p.startsWith('Change role play "Orchard Follow-up"') && /preUpload/.test(p)), `settings card: ${rpPrompts} | ${rpAsk.reply}`);
    assert(rpPrompts.some((p) => /tool preview/.test(p)), `tools card: ${rpPrompts} | ${rpAsk.reply}`);
    // The upload title wasn't given: the card must mark it as the copilot's suggestion.
    assert(rpPrompts.some((p) => /uploadTitle → "[^"]*" \(suggested\)/.test(p) || !/uploadTitle/.test(p)), `Expected a suggested upload title to be marked: ${rpPrompts}`);
    const rp = await approveAll(rpAsk);
    rp.expectOk();
    rp.calledTool("roleplay_settings_update", { count: 1 });
    rp.calledTool("roleplay_tools_update", { count: 1 });
    rpAsk.calledSkill("roleplay").soft();

    // persona: propose first, create only on the card
    const personaAsk = await pending(await t.send("I need a new persona: Daniel Reyes, a CFO who is precise, short on time and asks for numbers before opinions. Use the Granite Demo voice.", { headers }));
    assert(prompts(personaAsk).some((p) => p.startsWith('Create the persona "Daniel Reyes"')), `persona card: ${prompts(personaAsk)} | ${personaAsk.reply}`);
    t.calledSkill("persona"); // a write: the skill is required now (it may load on the confirming turn)
    const persona = await approveAll(personaAsk);
    persona.expectOk();
    persona.calledTool("persona_create", { count: 1 });

    // users
    const users = await t.send("Is Riley Example a learner here, and what are they assigned?", { headers });
    users.expectOk();
    users.calledTool("user_list");
    users.calledSkill("users").soft();
    assert.match(users.reply ?? "", /Silver Compass/i);

    // can't: no write tool, and the Studio section named
    const cant = await t.send("Delete the Orchard Follow-up role play.", { headers });
    cant.expectOk();
    for (const tool of ["roleplay_update", "roleplay_settings_update", "roleplay_tools_update"]) cant.notCalledTool(tool);
    assert.match(cant.reply ?? "", /can't|cannot/i);
    assert.match(cant.reply ?? "", /Scenarios/i);
  },
});
