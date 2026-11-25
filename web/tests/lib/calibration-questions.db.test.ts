import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as reportModel from "@/lib/report-model";
import { balancedSlots, nextCalibrationQuestions, type CalibrationSkill } from "@/lib/twin/calibration-questions";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "./minutes-test-db";

const skill = (name: string, situations: string[]): CalibrationSkill => ({ agentId: name, name, description: "", skill: "", situations });

test("balancedSlots takes skills in turn and the least-asked situations first", () => {
  const objections = skill("Objections", ["Too expensive", "Wait for market", "Wants a guarantee"]);
  const silent = skill("Silent", ["Stops responding"]);
  const slots = balancedSlots([objections, silent, skill("Empty", [])], 5, new Map([["Too expensive", 2]]));
  expect(slots.map((slot) => `${slot.skill.name}: ${slot.topic}`)).toEqual([
    "Objections: Wait for market", "Silent: Stops responding", "Objections: Wants a guarantee", "Silent: Stops responding", "Objections: Too expensive",
  ]);
  expect(balancedSlots([skill("Empty", [])], 3)).toEqual([]);
});

describe.skipIf(!localMinutesDb)("calibration questions (local database)", () => {
  let f: MinutesFixture;
  let model: ReturnType<typeof spyOn>;
  let skillId: string;
  beforeEach(async () => {
    f = minutesFixture(); await f.create();
    // The fixture twin becomes an all-skills twin with one skill twin listing three situations.
    const twin = await db.agent.update({ where: { id: f.twin.id }, data: { data: { source: "twin" } } });
    skillId = `${f.org.id}-skill`;
    await db.agent.create({ data: {
      id: skillId, slug: skillId, name: "Objection Handling", kind: "TWIN", orgId: f.org.id, personaId: twin.personaId,
      data: { skill: "## How I decide\nAsk what they compare it to first.", scenario: { skill: "objections", name: "Objection Handling", description: "Price pushback", situations: [
        { id: "too-expensive", name: "Too expensive" }, { id: "wait", name: "Wait for the market" }, { id: "guarantee", name: "Wants a guarantee" },
      ] } },
    } });
    model = spyOn(reportModel, "callReportModel");
  });
  afterEach(async () => {
    model.mockRestore();
    await db.twinCalibrationQuestion.deleteMany({ where: { orgId: f.org.id } });
    await f.clean();
  });

  /** The model writes "R<call>-<slot> <situation>?" for every slot it was given (new wording each call, as a model would). */
  const writesEverySlot = () => {
    let call = 0;
    model.mockImplementation(async (input: { user: string }) => {
      call += 1;
      return JSON.stringify({
        questions: [...input.user.matchAll(/^(\d+)\. Skill: .*?Situation: (.*)$/gm)].map(([, slot, topic]) => ({ slot: Number(slot), text: `R${call}-${slot} ${topic}?` })),
      });
    });
  };

  test("writes and keeps a round of questions across the skill's situations, metered as the org's evaluate work", async () => {
    writesEverySlot();
    const round = await nextCalibrationQuestions({ orgId: f.org.id, agentId: f.twin.id, count: 4 });
    expect(round).toHaveLength(4);
    expect(round.map((row) => row.topic).slice(0, 3).sort()).toEqual(["Too expensive", "Wait for the market", "Wants a guarantee"]);
    expect(round.every((row) => row.skillAgentId === skillId && row.source === "Objection Handling" && row.origin === "generated" && row.status === "new")).toBe(true);
    expect(model.mock.calls[0][0]).toMatchObject({ meter: { source: "evaluate", orgId: f.org.id } });
    expect(await db.twinCalibrationQuestion.count({ where: { agentId: f.twin.id } })).toBe(4);
  });

  test("uses unasked questions first and writes only what's missing, never repeating an asked one", async () => {
    writesEverySlot();
    await nextCalibrationQuestions({ orgId: f.org.id, agentId: f.twin.id, count: 3 });
    await db.twinCalibrationQuestion.updateMany({ where: { agentId: f.twin.id, topic: "Too expensive" }, data: { status: "asked" } });
    model.mockClear();
    const round = await nextCalibrationQuestions({ orgId: f.org.id, agentId: f.twin.id, count: 3 });
    expect(model).toHaveBeenCalledTimes(1);
    expect(model.mock.calls[0][0].user).toContain("- R1-0 Too expensive?"); // already asked, so listed to avoid
    expect(round).toHaveLength(3);
    expect(round.every((row) => row.status === "new")).toBe(true);
    model.mockClear();
    await nextCalibrationQuestions({ orgId: f.org.id, agentId: f.twin.id, count: 3 });
    expect(model).not.toHaveBeenCalled(); // three unasked ones are waiting
  });

  test("drops questions the model repeats or leaves empty", async () => {
    model.mockResolvedValue(JSON.stringify({ questions: [{ slot: 0, text: "Same?" }, { slot: 1, text: "same?" }, { slot: 2, text: " " }, { slot: 9, text: "No slot?" }] }));
    expect((await nextCalibrationQuestions({ orgId: f.org.id, agentId: f.twin.id, count: 3 })).map((row) => row.text)).toEqual(["Same?"]);
  });
});
