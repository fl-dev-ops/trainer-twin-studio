import assert from "node:assert/strict";
import { defineEval } from "eve/evals";

export default defineEval({
  description: "A trainer can decline a new persona or approve it with their chosen voice",
  tags: ["live"],
  async test(t) {
    const url = process.env.STUDIO_URL;
    const org = process.env.PERSONA_QA_ORG;
    const user = process.env.PERSONA_QA_USER;
    const voiceId = process.env.PERSONA_QA_VOICE;
    if (!url || !org || !user || !voiceId) return t.skip("Run against a prepared local studio fixture");
    assert(["localhost", "127.0.0.1"].includes(new URL(url).hostname));
    assert(org.startsWith("persona-qa-"));
    const headers = { authorization: `Basic ${Buffer.from(`${org}:${process.env.COPILOT_SERVICE_SECRET}`).toString("base64")}`, "x-trainertwin-user-id": user };
    async function list() {
      const res = await fetch(new URL("/api/internal/copilot-studio", url!), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${process.env.SCENARIO_INGEST_SECRET}`, "x-trainertwin-org-id": org!, "x-trainertwin-user-id": user! },
        body: JSON.stringify({ action: "listPersonas" }),
      });
      assert.equal(res.status, 200);
      return (await res.json() as { personas: { slug: string }[] }).personas.map(({ slug }) => slug);
    }
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
      if (optionId === "approve") result.calledTool("create_persona", { output: (output: unknown) =>
        typeof output === "object" && output !== null && "voice" in output && output.voice === voiceId,
      });
    }
    const proposeEdit = await t.send("Change the role-play persona Maya Approved's description to exactly: You ask one short question at a time. Leave the name, role, and voice alone.", { headers });
    const edit = proposeEdit.interactions.length ? proposeEdit : await proposeEdit.session.send("Those are the changes I want. Show me the approval card.", { headers });
    const editApproval = edit.interactions.find((i) => i.request.prompt?.includes('Change persona "maya-approved"'));
    assert(editApproval, `Expected an approval before updating the persona: ${edit.reply}`);
    const edited = await edit.session.respond([{ interactionId: editApproval.interactionId, optionId: "approve" }], { headers });
    edited.expectOk();
    edited.calledTool("update_persona", { count: 1 });

    const proposeTwin = await t.send("Create the main twin for the existing trainer persona QA Trainer. Do not create a twin skill.", { headers });
    const twin = proposeTwin.interactions.length ? proposeTwin : await proposeTwin.session.send("Yes, show me the approval card to create that main twin.", { headers });
    const twinApproval = twin.interactions.find((i) => i.request.prompt?.includes("Create the main twin"));
    assert(twinApproval, `Expected main twin approval: ${twin.reply}`);
    const createdTwin = await twin.session.respond([{ interactionId: twinApproval.interactionId, optionId: "approve" }], { headers });
    createdTwin.expectOk();
    createdTwin.calledTool("create_twin", { count: 1 });
  },
});
