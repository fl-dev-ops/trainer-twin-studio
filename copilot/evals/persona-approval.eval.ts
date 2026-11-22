import assert from "node:assert/strict";
import { defineEval } from "eve/evals";

export default defineEval({
  description: "Studio Copilot reads the roster and knowledge, and saves approved persona, twin, and role-play changes",
  tags: ["live"],
  async test(t) {
    const url = process.env.STUDIO_URL;
    const org = process.env.PERSONA_QA_ORG;
    const user = process.env.PERSONA_QA_USER;
    const voiceId = process.env.PERSONA_QA_VOICE;
    const phrase = process.env.PERSONA_QA_PHRASE;
    if (!url || !org || !user || !voiceId || !phrase) return t.skip("Run against a prepared local studio fixture");
    assert(["localhost", "127.0.0.1"].includes(new URL(url).hostname));
    assert(org.startsWith("persona-qa-"));
    const headers = { authorization: `Basic ${Buffer.from(`${org}:${process.env.COPILOT_SERVICE_SECRET}`).toString("base64")}`, "x-trainertwin-user-id": user };
    const studio = (body: Record<string, unknown>) => fetch(new URL("/api/internal/copilot-studio", url), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.SCENARIO_INGEST_SECRET}`, "x-trainertwin-org-id": org, "x-trainertwin-user-id": user },
      body: JSON.stringify(body),
    });
    async function list() {
      const res = await studio({ action: "listPersonas" });
      assert.equal(res.status, 200);
      return (await res.json() as { personas: { slug: string }[] }).personas.map(({ slug }) => slug);
    }
    const roster = await t.send("What is Riley Example's role in this organization, and which twin and role play are assigned to Riley now?", { headers });
    roster.expectOk();
    roster.calledTool("user_list");
    const reply = roster.reply;
    assert(reply, "Expected a roster reply");
    for (const expected of [/Riley Example/i, /learner/i, /Silver Compass/i, /Orchard Follow-up/i]) assert.match(reply, expected);

    const knowledge = await t.send("Read the Demo Playbook in our knowledge base. What exact fallback phrase does it specify for an unconfirmed demo?", { headers });
    knowledge.expectOk();
    assert(knowledge.reply?.includes(phrase), `Expected the phrase from the seeded document; got ${knowledge.reply}`);

    for (const optionId of ["deny", "approve"] as const) {
      const name = optionId === "deny" ? "Maya Denied" : "Maya Approved";
      const slug = name.toLowerCase().replace(" ", "-");
      const proposal = await t.send(`Create a new persona in our library: ${name}, Buyer, with this description: You are curious and calm. Use the voice Granite Demo. I want the persona only, not a role play.`, { headers });
      assert(!(await list()).includes(slug), "The persona was saved before approval");
      const pending = proposal.interactions.length ? proposal : await proposal.session.send("Those are the details I want. Show me the approval card.", { headers });
      const approval = pending.interactions.find((i) => i.request.prompt?.includes(`Create the persona "${name}"`));
      assert(approval, `Expected persona approval for ${name}: ${pending.reply}`);
      assert(!((await list()).includes(slug)), "The persona was saved before approval");
      const result = await pending.session.respond([{ interactionId: approval.interactionId, optionId }], { headers });
      result.expectOk();
      assert.equal((await list()).includes(slug), optionId === "approve");
      if (optionId === "approve") result.calledTool("persona_create", { output: (output: unknown) =>
        typeof output === "object" && output !== null && "voice" in output && output.voice === voiceId,
      });
    }
    const proposeEdit = await t.send("Change the role-play persona Maya Approved's description to exactly: You ask one short question at a time. Leave the name, role, and voice alone.", { headers });
    const edit = proposeEdit.interactions.length ? proposeEdit : await proposeEdit.session.send("Those are the changes I want. Show me the approval card.", { headers });
    const editApproval = edit.interactions.find((i) => /Change persona "(Maya Approved|maya-approved)"/.test(i.request.prompt ?? ""));
    assert(editApproval, `Expected an approval before updating the persona: ${edit.reply}`);
    const edited = await edit.session.respond([{ interactionId: editApproval.interactionId, optionId: "approve" }], { headers });
    edited.expectOk();
    edited.calledTool("persona_update", { count: 1 });

    const proposeTwin = await t.send("Create the main twin for the existing trainer persona QA Trainer. Do not create a twin skill.", { headers });
    const twin = proposeTwin.interactions.length ? proposeTwin : await proposeTwin.session.send("Yes, show me the approval card to create that main twin.", { headers });
    const twinApproval = twin.interactions.find((i) => i.request.prompt?.includes("Create the main twin"));
    assert(twinApproval, `Expected main twin approval: ${twin.reply}`);
    const createdTwin = await twin.session.respond([{ interactionId: twinApproval.interactionId, optionId: "approve" }], { headers });
    createdTwin.expectOk();
    createdTwin.calledTool("twin_create", { count: 1 });

    const approvalFor = async (ask: string, prefix: string) => {
      const first = await t.send(ask, { headers });
      const pending = first.interactions.length ? first : await first.session.send("Those details are final. Show me the approval card for this exact change.", { headers });
      const card = pending.interactions.find((i) => i.request.prompt?.startsWith(prefix));
      assert(card, `Expected ${prefix} approval: ${pending.reply}`);
      return async (tool: string) => {
        const result = await pending.session.respond([{ interactionId: card.interactionId, optionId: "approve" }], { headers });
        result.expectOk();
        result.calledTool(tool, { count: 1 });
      };
    };
    const approveTwinEdit = await approvalFor("Rename the main twin for QA Trainer to Compass Trainer Twin. Don't change anything else.", "Change twin");
    const unchangedTwin = await studio({ action: "get", kind: "twin", slug: `${org}-qa-trainer-twin` });
    assert.equal(unchangedTwin.status, 200);
    assert(!JSON.stringify(await unchangedTwin.json()).includes("Compass Trainer Twin"));
    await approveTwinEdit("twin_update");

    const approveRoleplay = await approvalFor(
      'Create and publish a role play titled "Renewal Check-in", brief ID renewal-check-in, played by the persona Maya Approved. The learner is an account manager calling a buyer about renewal. The buyer needs a clear follow-up date before deciding. Have the learner start, then have the buyer ask about the timeline and agree only if the learner proposes a date. Show the learner their goal before practice. Use no example items. These are the final requirements; show me the draft before requesting approval.',
      'Publish the role play "Renewal Check-in"',
    );
    const roleplaySlug = `${org}-renewal-check-in`;
    assert.equal((await studio({ action: "get", kind: "roleplay", slug: roleplaySlug })).status, 404);
    await approveRoleplay("roleplay_publish");

    const approveRoleplayEdit = await approvalFor('Update the published Renewal Check-in role play: turn on optional file upload before the call. Keep all other settings and the brief unchanged.', "Change role play");
    const unchangedRoleplay = await studio({ action: "get", kind: "roleplay", slug: roleplaySlug });
    assert.equal(unchangedRoleplay.status, 200);
    assert(!JSON.stringify(await unchangedRoleplay.json()).includes('"preUpload":true'));
    await approveRoleplayEdit("roleplay_settings_update");
  },
});
