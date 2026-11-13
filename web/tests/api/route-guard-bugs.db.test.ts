import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { NextRequest } from "next/server";
import * as nextHeaders from "next/headers";
import { auth } from "@/lib/auth";
import { OrganizationKnowledgeService } from "@/lib/org-knowledge";
import { MainCollectionService } from "@/lib/main-collection";
import * as specs from "@/lib/specs";
import { POST as speech } from "@/app/api/tts/speech/route";
import { GET as version } from "@/app/api/version/[type]/[id]/route";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "../lib/minutes-test-db";

describe.skipIf(!localMinutesDb)("route inventory guard regressions", () => {
  let f: MinutesFixture;
  const spies: { mockRestore(): void }[] = [];
  beforeEach(async () => {
    f = minutesFixture(); await f.create();
    spies.push(spyOn(nextHeaders, "headers").mockResolvedValue(new Headers({ host: "dash.trainertwin.com" })));
    spies.push(spyOn(auth.api, "getSession").mockResolvedValue({ user: f.learner, session: { activeOrganizationId: f.org.id } } as never));
  });
  afterEach(async () => { for (const spy of spies.splice(0).reverse()) spy.mockRestore(); await f.clean(); });
  test.each(["documents", "stats", "search", "documents/[id]/chunks", "documents/[id]/preview", "[kb]/search"])("refuses studio_only for learner knowledge read route %s before touching private knowledge", async (path) => {
    const before = await db.member.count({ where: { organizationId: f.org.id } });
    spies.push(spyOn(OrganizationKnowledgeService, "getAllDocuments").mockResolvedValue([]));
    spies.push(spyOn(OrganizationKnowledgeService, "getStats").mockResolvedValue({} as never));
    spies.push(spyOn(OrganizationKnowledgeService, "getDocumentChunks").mockResolvedValue([]));
    spies.push(spyOn(OrganizationKnowledgeService, "getPreviewUrl").mockResolvedValue("https://private.test/document"));
    spies.push(spyOn(MainCollectionService, "searchKnowledge").mockResolvedValue([]));
    const route = await import(`../../app/api/knowledge/${path}/route.ts`);
    const response = await route.GET(new Request(`https://dash.test/api/knowledge/${path}?q=private`), { params: Promise.resolve({ id: "private-document", kb: "private-kb" }) });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: "studio_only", error: "Only the organization's admin and team can do this." });
    expect(await db.member.count({ where: { organizationId: f.org.id } })).toBe(before);
  });
  test("refuses studio_only for learner version reads before touching a private spec", async () => {
    const read = spyOn(specs, "readVersion").mockResolvedValue({ text: "private" } as never); spies.push(read);
    const before = await db.member.count({ where: { organizationId: f.org.id } });
    const response = await version(new Request("https://dash.test/api/version/agents/private?v=1"), { params: Promise.resolve({ type: "agents", id: "private" }) });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Only the organization's admin and team can do this.", code: "studio_only" });
    expect(read).not.toHaveBeenCalled(); expect(await db.member.count({ where: { organizationId: f.org.id } })).toBe(before);
  });
  test("refuses studio_only and signed_out on TTS speech without spending upstream credits", async () => {
    const before = await db.member.count({ where: { organizationId: f.org.id } });
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(new Response("audio")); spies.push(fetch);
    for (const code of ["studio_only", "signed_out"]) {
      if (code === "signed_out") spies.push(spyOn(auth.api, "getSession").mockResolvedValue(null));
      const response = await speech(new NextRequest("https://dash.test/api/tts/speech", { method: "POST", body: JSON.stringify({ input: "private" }), headers: { authorization: "Bearer wrong-key" } }));
      expect(response.status).toBe(code === "studio_only" ? 403 : 401);
      expect(await response.json()).toEqual({ code, error: code === "studio_only" ? "Only the organization's admin and team can do this." : "Sign in first." });
      expect(fetch).not.toHaveBeenCalled();
    }
    expect(await db.member.count({ where: { organizationId: f.org.id } })).toBe(before);
  });
  test("TTS speech accepts its exact service key without a login and keeps upstream credentials server-side", async () => {
    const previous = { TTS_SERVICE_KEY: process.env.TTS_SERVICE_KEY, TTS_SERVICE_URL: process.env.TTS_SERVICE_URL };
    process.env.TTS_SERVICE_KEY = "module-one-service-key"; process.env.TTS_SERVICE_URL = "https://tts.test/";
    const session = spyOn(auth.api, "getSession").mockResolvedValue(null); spies.push(session);
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(new Response("pcm-data", { headers: { "content-type": "audio/pcm", "x-sample-rate": "16000" } })); spies.push(fetch);
    try {
      const response = await speech(new NextRequest("https://dash.test/api/tts/speech", { method: "POST", headers: { authorization: "Bearer module-one-service-key" }, body: JSON.stringify({ input: "Hello" }) }));
      expect(response.status).toBe(200); expect(await response.text()).toBe("pcm-data");
      expect(response.headers.get("x-sample-rate")).toBe("16000"); expect(response.headers.get("cache-control")).toBe("no-store");
      expect(session).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledWith("https://tts.test/v1/audio/speech", expect.objectContaining({ method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer module-one-service-key" }, body: JSON.stringify({ model: "voxcpm2", response_format: "pcm", stream: true, input: "Hello" }) }));
      expect(response.headers.has("authorization")).toBe(false);
    } finally { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });
  test("the unguarded internal Chroma tenant and copilot document routes are gone (nothing called them)", async () => {
    for (const path of ["internal/orgs/[orgId]/chroma-tenant", "copilot/document"]) expect(await Bun.file(`app/api/${path}/route.ts`).exists()).toBe(false);
  });
});
