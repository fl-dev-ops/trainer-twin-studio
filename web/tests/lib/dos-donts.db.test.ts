import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as reportModel from "@/lib/report-model";
import { addDoDont, editDoDont, removeDoDont, twinDosDonts, verbatimRules } from "@/lib/twin/dos-donts";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "./minutes-test-db";

const PLAYBOOK = `## How I decide
- Whatever the objection, I always move the client to booking a next step.
- I do not use leading "logical trap" questions.
- When a client says "it is too expensive", I do not explain or defend.`;

test("verbatimRules keeps a crisp line only when its original is in the playbook as written, at most three", () => {
  expect(verbatimRules([
    { original: "Whatever the objection, I always move the client to booking a next step.", crisp: "Move every objection to a booked next step." },
    { original: "I always move clients to a call.", crisp: "Book a call" }, // original reworded: dropped
    { original: "I do not use leading “logical trap” questions.", crisp: "Use leading trap questions" }, // curly quotes still match
    { original: "Whatever the objection, I always move the client to booking a next step.", crisp: "Again" }, // repeated
    { original: "- When a client says \"it is too expensive\", I do not explain or defend.", crisp: "Explain or defend the price when it's called too expensive, ever, in any shape or form at all really" }, // too long
    "a plain string",
  ], PLAYBOOK)).toEqual([
    { text: "Move every objection to a booked next step", original: "Whatever the objection, I always move the client to booking a next step." },
    { text: "Use leading trap questions", original: "I do not use leading \"logical trap\" questions." },
  ]);
});

describe.skipIf(!localMinutesDb)("twin Do's & Don'ts (local database)", () => {
  let f: MinutesFixture;
  let model: ReturnType<typeof spyOn>;
  let skillId: string;
  beforeEach(async () => {
    f = minutesFixture(); await f.create();
    // The fixture twin becomes an all-skills twin with one skill twin (one topic).
    const twin = await db.agent.update({ where: { id: f.twin.id }, data: { data: { source: "twin" } } });
    skillId = `${f.org.id}-skill`;
    await db.agent.create({ data: {
      id: skillId, slug: skillId, name: "Objection Handling", kind: "TWIN", orgId: f.org.id, personaId: twin.personaId,
      data: { skill: PLAYBOOK, scenario: { skill: "objections", name: "Objection Handling", description: "Price pushback", situations: [{ id: "a", name: "A" }, { id: "b", name: "B" }] } },
    } });
    model = spyOn(reportModel, "callReportModel").mockResolvedValue(JSON.stringify({
      dos: [
        { original: "Whatever the objection, I always move the client to booking a next step.", crisp: "Move every objection to a booked next step" },
        { original: "I always win.", crisp: "Win" },
      ],
      donts: [
        { original: "I do not use leading \"logical trap\" questions.", crisp: "Use leading trap questions" },
        { original: "When a client says \"it is too expensive\", I do not explain or defend.", crisp: "Defend the price when called too expensive" },
      ],
    }));
  });
  afterEach(async () => {
    model.mockRestore();
    await db.twinDoDont.deleteMany({ where: { orgId: f.org.id } });
    await f.clean();
  });

  const list = () => twinDosDonts({ orgId: f.org.id, agentId: f.twin.id });

  test("picked once from the playbook, quoted as written; later loads return the saved list without the model", async () => {
    const [topic] = await list();
    expect(topic).toMatchObject({ skillAgentId: skillId, name: "Objection Handling" });
    expect(topic.dos.map((rule) => rule.text)).toEqual(["Move every objection to a booked next step"]); // "I always win." isn't in it
    expect(topic.dos[0].originalText).toBe("Whatever the objection, I always move the client to booking a next step.");
    expect(topic.donts).toHaveLength(2);
    expect(topic.donts[0]).toMatchObject({ text: "Use leading trap questions", source: "playbook", originalText: "I do not use leading \"logical trap\" questions.", suggestion: false });
    expect(model).toHaveBeenCalledTimes(1);
    expect(model.mock.calls[0][0]).toMatchObject({ meter: { source: "evaluate", orgId: f.org.id } });
    await list();
    expect(model).toHaveBeenCalledTimes(1);
  });

  test("the coach edits, adds and removes; a team member's change is a suggestion; another org can't change it", async () => {
    const [topic] = await list();
    const rule = topic.donts[0];
    await editDoDont({ orgId: f.org.id, userId: f.trainer.id, id: rule.id, text: "I never ask trap questions." });
    await addDoDont({ orgId: f.org.id, userId: f.trainer.id, agentId: f.twin.id, skillAgentId: skillId, kind: "do", text: "I ask what they compare it to." });
    let [now] = await list();
    expect(now.donts[0]).toMatchObject({ text: "I never ask trap questions.", originalText: rule.originalText, source: "edited", suggestion: false });
    expect(now.dos.at(-1)).toMatchObject({ text: "I ask what they compare it to.", originalText: null, source: "added" });

    // Changed to the playbook's own sentence: the playbook's line again.
    await editDoDont({ orgId: f.org.id, userId: f.trainer.id, id: rule.id, text: rule.originalText! });
    [now] = await list();
    expect(now.donts[0]).toMatchObject({ source: "playbook" });

    // Removed, then restored.
    await removeDoDont({ orgId: f.org.id, userId: f.trainer.id, id: rule.id });
    [now] = await list();
    expect(now.donts.map((r) => r.id)).not.toContain(rule.id);
    await removeDoDont({ orgId: f.org.id, userId: f.trainer.id, id: rule.id, restore: true });
    [now] = await list();
    expect(now.donts.map((r) => r.id)).toContain(rule.id);

    // A team member's edit is shown as a suggestion (the fixture's trainer is the org admin, the coach).
    const teamId = `${f.org.id}-team`;
    await db.user.create({ data: { id: teamId, name: "Cathy", email: `${teamId}@example.com`, emailVerified: true } });
    await db.member.create({ data: { id: `${teamId}-member`, userId: teamId, organizationId: f.org.id, role: "team", createdAt: new Date() } });
    await editDoDont({ orgId: f.org.id, userId: teamId, id: rule.id, text: "Cathy's wording." });
    [now] = await list();
    expect(now.donts.find((r) => r.id === rule.id)).toMatchObject({ editedBy: "Cathy", suggestion: true });

    await expect(editDoDont({ orgId: "other-org", userId: f.trainer.id, id: rule.id, text: "x" })).rejects.toMatchObject({ code: "not_found" });
    await expect(addDoDont({ orgId: f.org.id, userId: f.trainer.id, agentId: f.twin.id, skillAgentId: skillId, kind: "do", text: "   " })).rejects.toMatchObject({ code: "invalid_input" });
  });
});
