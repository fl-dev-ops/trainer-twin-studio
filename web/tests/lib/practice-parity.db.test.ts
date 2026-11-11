import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as nextHeaders from "next/headers";
import * as nextServer from "next/server";
import * as identity from "@/lib/session-user";
import * as runner from "@/lib/run-session-start";
import { activateSession } from "@/lib/interview-sessions";
import { openSession, startRefusal } from "@/lib/session-activation";
import { loadSharedSession, loadTwinLink, twinAccessFor } from "@/lib/pages/learner";
import { POST } from "@/app/api/sessions/route";
import { fundOrg } from "../setup/meteroid";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "./minutes-test-db";

type Case = { name: string; code?: string; message?: string; reason?: string; seconds?: number; studio?: boolean; unbilled?: boolean; state?: "signedOut" | "nonmember" | "disabled" | "unassigned" | "revoked" | "ended" | "archived" | "otherOrg" | "linkDisabled" | "paused" };
const rows: Case[] = [
  { name: "signed out", state: "signedOut", code: "signed_out", message: "Sign in first." },
  { name: "BUG non-member personal page must check membership first (actual twin_not_assigned message)", state: "nonmember", code: "no_org", reason: "notMember", message: "You're not a member of this organization." },
  { name: "disabled", state: "disabled", code: "member_disabled", reason: "blocked", message: "Your access to this organization has been turned off. Ask its admin to turn it back on." },
  { name: "learner without assignment", state: "unassigned", code: "twin_not_assigned", reason: "unassigned", message: "This twin isn't assigned to you. Ask your trainer for access." },
  { name: "revoked", state: "revoked", code: "twin_access_revoked", reason: "ended", message: "Your access to this twin was removed. Ask your trainer if you need it again." },
  { name: "accessUntil passed", state: "ended", code: "twin_access_ended", reason: "ended", message: "Your access to this twin has ended. Ask your trainer if you need more time." },
  { name: "BUG archived twin: twinAccessFor must refuse not_found (actual usable assignment offers Start)", state: "archived", code: "not_found", reason: "blocked", message: "Not found." },
  { name: "BUG archived studio preview: twinAccessFor must refuse not_found (actual preview offers Start)", state: "archived", studio: true, code: "not_found", reason: "blocked", message: "Not found." },
  { name: "other-org code (not a /t state)", state: "otherOrg", code: "not_found", message: "Not found." },
  { name: "disabled common link (personal /t and /s stay usable)", state: "linkDisabled", code: "twin_link_disabled", message: "This link is no longer active. Ask your trainer for a new one." },
  { name: "paused learner", state: "paused", code: "org_paused", reason: "blocked", message: "Practice is paused for this organization right now. Please ask your trainer." },
  { name: "paused studio", state: "paused", studio: true, code: "org_paused", reason: "blocked", message: "Your organization's plan is paused because an invoice is overdue. Pay it to continue (Settings › Billing)." },
  ...[0, 30].map((seconds): Case => ({ name: `learner ${seconds}s`, seconds, code: "credits_out", reason: "used", message: "You've used all your practice minutes. Ask your trainer for more." })),
  ...[1, 2, 3, 4].map((minutes): Case => ({ name: `learner ${minutes}min`, seconds: minutes * 60, code: "credits_short", reason: "blocked", message: `You need at least 5 minutes to start a call; you have ${minutes}. Ask your trainer for more.` })),
  { name: "learner exactly 5min", seconds: 300 },
  { name: "studio unbilled/free", studio: true, unbilled: true },
  ...[0, 30].map((seconds): Case => ({ name: `studio billed ${seconds}s`, studio: true, seconds, code: "org_credits_out", reason: "blocked", message: "Your organization has no credits left. Contact TrainerTwin to add more." })),
  ...[1, 2, 3, 4].map((minutes): Case => ({ name: `studio billed ${minutes}min`, studio: true, seconds: minutes * 60, code: "org_credits_short", reason: "blocked", message: `Your organization needs at least 5 credits to start a call; it has ${minutes}. Contact TrainerTwin to add more.` })),
  { name: "studio billed exactly 5min", studio: true, seconds: 300 },
];

describe.skipIf(!localMinutesDb)("Module 2 page-vs-Start parity (real PostgreSQL)", () => {
  let f: MinutesFixture;
  let other: MinutesFixture;
  const spies: { mockRestore(): void }[] = [];
  let who: ReturnType<typeof spyOn<typeof identity, "resolveSessionUser">>;
  let secret: string | undefined;
  beforeEach(async () => {
    f = minutesFixture(); await f.create();
    other = minutesFixture(); await other.create();
    secret = process.env.COPILOT_SERVICE_SECRET; process.env.COPILOT_SERVICE_SECRET = "parity-secret";
    who = spyOn(identity, "resolveSessionUser").mockResolvedValue({ org: { ...f.org, accentColor: null }, user: f.learner, signInUrl: "/sign-in" });
    const fetch = globalThis.fetch;
    spies.push(who, spyOn(nextHeaders, "headers").mockResolvedValue(new Headers({ host: `${f.org.slug}.test` })),
      spyOn(nextServer, "after").mockImplementation(() => {}),
      // Real openSession/activation; LiveKit/workflow transport is outside this parity test.
      spyOn(runner, "runSessionStart").mockImplementation(openSession),
      spyOn(globalThis, "fetch").mockImplementation((url, init) => String(url).includes("meteroid.test") ? fetch(url, init) : Promise.resolve(new Response(null, { status: 204 }))));
  });
  afterEach(async () => {
    for (const spy of spies.splice(0).reverse()) spy.mockRestore();
    if (secret === undefined) delete process.env.COPILOT_SERVICE_SECRET; else process.env.COPILOT_SERVICE_SECRET = secret;
    await f.clean(); await other.clean();
  });
  const post = (code: string) => POST(new Request("https://test/api/sessions", { method: "POST", body: JSON.stringify({ shareCode: code }) }));
  const clearCalls = () => db.interviewSession.deleteMany({ where: { orgId: f.org.id } });

  const check = async (row: Case) => {
    const user = row.studio ? f.trainer : f.learner;
    who.mockResolvedValue({ org: { ...f.org, accentColor: null }, user: row.state === "signedOut" ? null : user, signInUrl: "/sign-in" });
    if (!row.unbilled) await fundOrg({ orgId: f.org.id, minutes: row.studio ? (row.seconds ?? 600) / 60 : 100 });
    if (!row.studio && row.seconds !== 0) await db.minuteLedger.create({ data: { orgId: f.org.id, email: user.email, type: "grant", seconds: row.seconds ?? 600 } });
    const personal = await db.twinAssignment.create({ data: { orgId: f.org.id, agentId: f.twin.id, userId: f.learner.id, shareCode: `${f.org.id}-personal`, minutesLimit: 30 } });
    const link = await db.twinShareLink.create({ data: { orgId: f.org.id, agentId: f.twin.id, code: `${f.org.id}-common`, minutesPerUser: 30, createdByUserId: f.trainer.id } });
    let personalCode = personal.shareCode;
    let commonCode = link.code;
    if (row.state === "nonmember" || row.state === "unassigned") {
      await db.member.create({ data: { id: `${f.org.id}-other-member`, organizationId: f.org.id, userId: other.learner.id, role: "user", createdAt: new Date() } });
      if (row.state === "nonmember") {
        await db.member.delete({ where: { id: `${user.id}-member` } });
        personalCode = (await db.twinAssignment.create({ data: { orgId: f.org.id, agentId: f.twin.id, userId: other.learner.id, shareCode: `${f.org.id}-someone-else`, minutesLimit: 30 } })).shareCode;
      }
    }
    if (row.state === "disabled") await db.member.update({ where: { id: `${user.id}-member` }, data: { disabledAt: new Date() } });
    if (row.state === "unassigned") {
      await db.twinAssignment.delete({ where: { id: personal.id } });
      personalCode = (await db.twinAssignment.create({ data: { orgId: f.org.id, agentId: f.twin.id, userId: other.learner.id, shareCode: `${f.org.id}-someone-else`, minutesLimit: 30 } })).shareCode;
    }
    if (row.state === "revoked") await db.twinAssignment.update({ where: { id: personal.id }, data: { status: "revoked" } });
    if (row.state === "ended") await db.twinAssignment.update({ where: { id: personal.id }, data: { accessUntil: new Date(0) } });
    if (row.state === "archived") await db.agent.update({ where: { id: f.twin.id }, data: { archivedAt: new Date() } });
    if (row.state === "linkDisabled") await db.twinShareLink.update({ where: { id: link.id }, data: { status: "disabled" } });
    if (row.state === "otherOrg") {
      personalCode = (await db.twinAssignment.create({ data: { orgId: other.org.id, agentId: other.twin.id, userId: other.learner.id, shareCode: `${other.org.id}-personal`, minutesLimit: 30 } })).shareCode;
      commonCode = (await db.twinShareLink.create({ data: { orgId: other.org.id, agentId: other.twin.id, code: `${other.org.id}-common`, minutesPerUser: 30 } })).code;
    }
    if (row.state === "paused") await db.orgBilling.update({ where: { orgId: f.org.id }, data: { plan: "paid", paidSubscriptionId: `paid-${f.org.id}`, pausedAt: new Date() } });
    const start = async (code: string, bySlug = false) => {
      const direct = row.state === "signedOut" ? null : await activateSession({ orgId: f.org.id, userId: user.id, ...(bySlug ? { agentSlug: f.twin.slug } : { shareCode: code }) }).then(() => ({ ok: true }), startRefusal);
      await clearCalls();
      const response = bySlug ? await POST(new Request("https://test/api/sessions", { method: "POST", body: JSON.stringify({ agentSlug: f.twin.slug }) })) : await post(code); const body: unknown = await response.json(); await clearCalls();
      return { direct, status: response.status, body };
    };
    // Snapshot before the common page's deliberate rule-3 join; Start never joins.
    const personalStart = await start(personalCode, Boolean(row.studio));
    const commonStart = await start(commonCode);
    const access = await twinAccessFor(f.org, row.state === "signedOut" ? null : user, f.twin.id);
    const twinPage = await loadTwinLink("twin");
    const personalPage = await loadSharedSession(personalCode);
    const commonPage = await loadSharedSession(commonCode);
    const assertStart = (actual: Awaited<ReturnType<typeof start>>, refused: boolean) => {
      expect(actual.status).toBe(refused ? (row.code === "signed_out" ? 401 : row.code === "not_found" ? 404 : 403) : 200);
      if (refused) {
        expect(actual.body).toEqual({ code: row.code, error: row.message });
        if (actual.direct) expect(actual.direct).toEqual({ ok: false, code: row.code, status: actual.status, error: row.message });
      } else expect(actual.direct).toEqual({ ok: true });
    };
    const linkOnly = row.state === "linkDisabled";
    assertStart(personalStart, Boolean(row.code) && !linkOnly);
    assertStart(commonStart, Boolean(row.code));
    if (row.state === "signedOut") {
      expect(access).toBeNull(); expect(personalPage.kind).toBe("signIn"); expect(commonPage.kind).toBe("signIn"); return;
    }
    if (row.state === "otherOrg" || linkOnly) expect(access).toMatchObject({ ok: true });
    else if (row.code) expect(access).toMatchObject({ ok: false, reason: row.reason, message: row.message });
    else expect(access).toMatchObject({ ok: true, preview: Boolean(row.studio) });
    if (row.state === "archived") expect(twinPage).toEqual({ kind: "notFound" });
    const assertPage = (page: Awaited<ReturnType<typeof loadSharedSession>>, refused: boolean) => {
      if (!refused) expect(page.kind).toBe("session");
      else if (row.code === "credits_out" || row.code === "credits_short") expect(page).toEqual({ kind: "outOfMinutes", email: user.email, minutesLeft: Math.floor((row.seconds ?? 0) / 60) });
      else expect(page).toEqual({ kind: "twinUnavailable", email: user.email, message: row.message });
    };
    if (row.studio && row.state !== "archived") expect(personalPage).toEqual({ kind: "twinUnavailable", email: user.email, message: "This twin isn't assigned to you. Ask your trainer for access." });
    else assertPage(personalPage, Boolean(row.code) && !linkOnly);
    if (row.state === "unassigned" || row.state === "nonmember") {
      // Common /s joins an enabled existing member, unlike /t and Start-before-join.
      expect(commonPage.kind).toBe("session");
      expect(await db.twinAssignment.count({ where: { agentId: f.twin.id, userId: user.id } })).toBe(1);
      expect(await twinAccessFor(f.org, user, f.twin.id)).toMatchObject({ ok: true });
      expect((await start(commonCode)).status).toBe(200);
    } else assertPage(commonPage, Boolean(row.code));
  };
  test.each(rows.filter((row) => !row.code))("$name", check);
  test.each(rows.filter((row) => row.name.startsWith("BUG")))("$name", check);
  test.each(rows.filter((row) => row.code === "signed_out"))("refuses signed_out at PG and ST: $name", check);
  test.each(rows.filter((row) => row.code === "member_disabled"))("refuses member_disabled at PG and ST: $name", check);
  test.each(rows.filter((row) => row.code === "twin_not_assigned"))("refuses twin_not_assigned at PG and ST: $name", check);
  test.each(rows.filter((row) => row.code === "twin_access_revoked"))("refuses twin_access_revoked at PG and ST: $name", check);
  test.each(rows.filter((row) => row.code === "twin_access_ended"))("refuses twin_access_ended at PG and ST: $name", check);
  test.each(rows.filter((row) => row.code === "twin_link_disabled"))("refuses twin_link_disabled at PG and ST: $name", check);
  test.each(rows.filter((row) => row.code === "org_paused"))("refuses org_paused at PG and ST: $name", check);
  test.each(rows.filter((row) => row.code === "credits_out"))("refuses credits_out at PG and ST: $name", check);
  test.each(rows.filter((row) => row.code === "credits_short"))("refuses credits_short at PG and ST: $name", check);
  test.each(rows.filter((row) => row.code === "org_credits_out"))("refuses org_credits_out at PG and ST: $name", check);
  test.each(rows.filter((row) => row.code === "org_credits_short"))("refuses org_credits_short at PG and ST: $name", check);
  test.each(rows.filter((row) => row.code === "not_found" && !row.name.startsWith("BUG")))("refuses not_found at PG and ST: $name", check);

  test("refuses twin_not_assigned when studio uses someone else's personal link at PG and ST", async () => {
    who.mockResolvedValue({ org: { ...f.org, accentColor: null }, user: f.trainer, signInUrl: "/sign-in" });
    const personal = await db.twinAssignment.create({ data: { orgId: f.org.id, agentId: f.twin.id, userId: f.learner.id, shareCode: `${f.org.id}-personal`, minutesLimit: 30 } });
    const message = "This twin isn't assigned to you. Ask your trainer for access.";
    expect(await loadSharedSession(personal.shareCode)).toEqual({ kind: "twinUnavailable", email: f.trainer.email, message });
    await expect(activateSession({ orgId: f.org.id, userId: f.trainer.id, shareCode: personal.shareCode })).rejects.toMatchObject({ code: "twin_not_assigned", status: 403, message });
    const response = await post(personal.shareCode); expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: "twin_not_assigned", error: message });
  });

  test("refuses voice_only on POST before any call is created", async () => {
    const personal = await db.twinAssignment.create({ data: { orgId: f.org.id, agentId: f.twin.id, userId: f.learner.id, shareCode: `${f.org.id}-personal`, minutesLimit: 30 } });
    const response = await POST(new Request("https://test/api/sessions", { method: "POST", body: JSON.stringify({ shareCode: personal.shareCode, mode: "chat" }) }));
    expect(response.status).toBe(400); expect(await response.json()).toEqual({ code: "voice_only", error: "Twin calls are voice only." });
    expect(await db.interviewSession.count({ where: { orgId: f.org.id } })).toBe(0);
  });

  test("refuses studio_only for a learner POST by slug even with usable twin access", async () => {
    const response = await POST(new Request("https://test/api/sessions", { method: "POST", body: JSON.stringify({ agentSlug: f.twin.slug }) }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: "studio_only", error: "Only the organization's admin and team can do this." });
    expect(await db.interviewSession.count({ where: { orgId: f.org.id } })).toBe(0);
  });
});
