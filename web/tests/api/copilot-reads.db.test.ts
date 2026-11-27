import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { POST as studio } from "@/app/api/internal/copilot-studio/route";
import { db, localMinutesDb, minutesFixture, setTwinPublic } from "../lib/minutes-test-db";

/**
 * The copilot's reads over HTTP against real Postgres (lib/copilot-reads.ts): a session full of private canaries in
 * this org and one in another org, and every read action checked for scope and for each canary anywhere in its answer.
 */
describe.skipIf(!localMinutesDb)("Copilot reads: privacy contract (real Postgres)", () => {
  const org = minutesFixture(), other = minutesFixture();
  const secret = "copilot-reads-test";
  const previous = process.env.SCENARIO_INGEST_SECRET;
  const canary = {
    share: `SHARE-${crypto.randomUUID()}`,
    token: `TOKEN-${crypto.randomUUID()}`,
    activation: `ACT-${crypto.randomUUID()}`,
    // 64 characters, as the column requires.
    ip: `IPHASH${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "")}`.slice(0, 64),
    visitorId: `VISITOR${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "")}`.slice(0, 64),
    origin: "https://canary-customer.example",
    audio: `voice/canary/${crypto.randomUUID()}.ogg`,
    audioUrl: `https://canary.example/signed/${crypto.randomUUID()}`,
    room: `ROOM-${crypto.randomUUID()}`,
    cv: `Canary_CV_${crypto.randomUUID()}.pdf`,
    otherOrgWords: `other-org-transcript-${crypto.randomUUID()}`,
  };
  let sessionId = "", otherSessionId = "";

  beforeAll(async () => {
    process.env.SCENARIO_INGEST_SECRET = secret;
    await org.create();
    await other.create();
    await db.user.update({ where: { id: org.learner.id }, data: { name: "Priya Canary" } });
    sessionId = (await org.session({
      shareCode: canary.share, runtimeTokenHash: canary.token, activationKey: canary.activation,
      s3AudioKey: canary.audio, livekitRoom: canary.room, contextName: canary.cv,
      transcript: [{ role: "assistant", text: "Welcome back." }, { role: "user", text: "Thanks, ready to practise." }],
      feedbackNote: "Good one.", reportStatus: "completed",
      report: {
        summary: "Solid.", summaryTags: ["Discovery"], focusNextTime: "Close sooner.", generatedAt: new Date().toISOString(),
        keyMoments: [{ id: "k", number: "1", title: "Open", quote: "Ready to practise.", description: "Warm start.", audioUrl: canary.audioUrl }],
      },
    })).id;
    // A website bot with public calls on (anonymous sessions are only for those), visited from a customer's site.
    await setTwinPublic(org, { publicAccess: { enabled: true, maxSeconds: 300 }, widget: { allowedOrigins: [canary.origin], welcome: "Hi", accentColor: "#123456" } });
    const bot = await db.agent.findFirstOrThrow({ where: { orgId: org.org.id, kind: "BOT" }, select: { id: true, slug: true } });
    // A website visitor: self-reported name, IP hash and the site they came from (both must never be read).
    await org.session({
      userId: null, anonymousId: canary.visitorId, anonymousName: "Website Visitor", anonymousIpHash: canary.ip,
      embedOrigin: canary.origin, chargesOrg: true, allowedSeconds: 300, agentId: bot.id, agentSlug: bot.slug,
    });
    otherSessionId = (await other.session({ transcript: [{ role: "user", text: canary.otherOrgWords }] })).id;
  });
  afterAll(async () => {
    if (previous === undefined) delete process.env.SCENARIO_INGEST_SECRET;
    else process.env.SCENARIO_INGEST_SECRET = previous;
    await org.clean();
    await other.clean();
  });

  async function read(action: string, fields: Record<string, unknown> = {}) {
    const response = await studio(new Request("https://local.test/copilot-studio", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "x-trainertwin-org-id": org.org.id, "x-trainertwin-user-id": org.trainer.id },
      body: JSON.stringify({ action, ...fields }),
    }));
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }
  const leaks = (value: unknown) => {
    const json = JSON.stringify(value);
    const secrets = { ...canary, learnerEmail: org.learner.email, trainerEmail: org.trainer.email, otherOrgId: other.org.id };
    return Object.entries(secrets).filter(([, v]) => json.includes(v)).map(([k]) => k);
  };

  test("every read answers without one private value, and nothing of another org", async () => {
    const answers = await Promise.all([
      read("listSessions", { days: 90 }),
      read("readSession", { id: sessionId }),
      read("listCalibrations"),
      read("readUsage", { days: 90 }),
      read("listTeam"),
      read("readOrg"),
    ]);
    for (const { status, body } of answers) {
      expect(status).toBe(200);
      expect(leaks(body)).toEqual([]);
    }
    const [list, detail] = answers.map((a) => a.body);
    const sessions = list.sessions as { id: string; learner: string; kind: string }[];
    expect(sessions).toHaveLength(2);
    expect(sessions.find((s) => s.id === sessionId)?.learner).toBe("Priya Canary");
    expect(sessions.find((s) => s.id !== sessionId)).toMatchObject({ learner: "Website Visitor", kind: "bot" });
    expect(detail).toMatchObject({ hasRecording: true, learnerFeedback: "Good one." });
    expect((detail.transcript as { turns: unknown[] }).turns).toHaveLength(2);
  });

  test("another org's session is not found, not listed, not read", async () => {
    const { status, body } = await read("readSession", { id: otherSessionId });
    expect(status).toBe(404);
    expect(leaks(body)).toEqual([]);
  });

  test("a learner filter matches names, never emails", async () => {
    const byName = await read("listSessions", { days: 90, learner: "priya" });
    expect((byName.body.sessions as unknown[]).length).toBe(1);
    const byEmail = await read("listSessions", { days: 90, learner: org.learner.email.split("@")[0] });
    expect(byEmail.body.sessions).toEqual([]);
  });

  test("the team is named, with roles, without emails", async () => {
    const { body } = await read("listTeam");
    expect(body.team).toEqual([{ name: "Trainer", role: "admin", disabled: false, since: expect.any(String) }]);
  });

  test("billing and anything unknown is refused by the schema", async () => {
    for (const action of ["readBilling", "listInvoices", "listApiKeys"]) {
      expect((await read(action)).status).toBe(400);
    }
    expect((await read("listSessions", { email: org.learner.email })).status).toBe(400);
  });
});
