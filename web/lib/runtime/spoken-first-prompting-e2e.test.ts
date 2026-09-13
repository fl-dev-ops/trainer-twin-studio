import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { randomBytes, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { db } from "@/lib/db";
import { handleCompletions } from "./openai";

const DATA_DIR = path.resolve(import.meta.dir, "../../data");

function loadConfig(agentSlug = "resume-mastery", personaSlug = "vasanth") {
  const agentYaml = fs.readFileSync(path.join(DATA_DIR, `agents/${agentSlug}.yaml`), "utf8");
  const personaYaml = fs.readFileSync(path.join(DATA_DIR, `personas/${personaSlug}.yaml`), "utf8");
  const agentData = (yaml.load(agentYaml) as any).agent;
  const personaData = (yaml.load(personaYaml) as any).persona;
  const domainYaml = fs.readFileSync(path.join(DATA_DIR, `domains/${agentData.domain}.yaml`), "utf8");
  const domainData = (yaml.load(domainYaml) as any).domain;

  return {
    persona: { id: "test-vasanth", slug: personaSlug, version: 1, data: personaData },
    agent: { id: "test-agent", slug: agentSlug, version: 1, data: agentData },
    domain: { slug: agentData.domain, version: 1, data: domainData },
    knowledgeBases: [],
  };
}

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

describe("Spoken-First Prompting & Deictic Show-and-Tell E2E", () => {
  let orgId: string;
  let userId: string;
  let agentId: string;
  let sessionId = `test-sess-spoken-${randomBytes(4).toString("hex")}`;
  let runtimeToken = `test-token-${randomBytes(16).toString("hex")}`;

  beforeAll(async () => {
    const existingAgent = await db.agent.findFirstOrThrow();
    agentId = existingAgent.id;
    orgId = existingAgent.orgId!;

    const existingMember = await db.member.findFirstOrThrow({
      where: { organizationId: orgId },
    });
    userId = existingMember.userId;

    const baseConfig = loadConfig("resume-mastery", "vasanth");

    await db.interviewSession.create({
      data: {
        id: sessionId,
        orgId,
        userId,
        agentId: existingAgent.id,
        shareCode: randomBytes(8).toString("hex"),
        runtimeTokenHash: tokenHash(runtimeToken),
        personaSlug: "vasanth",
        personaVersion: 1,
        agentSlug: "resume-mastery",
        agentVersion: 1,
        domainSlug: "software-engineering-resume",
        domainVersion: 1,
        status: "active",
        compiledSnapshot: baseConfig,
        runtimeState: {
          phase_index: 0,
          phase_turns: 0,
          learner_turns: 0,
          coverage: {},
          claims: [],
          evidence_probe_counts: {},
          pending_evidence_key: null,
          actions: [],
          grounding_probes: [],
          grounding_probe_counts: {},
          current_surface: "open_code_editor",
          pending_document_lookup: null,
        },
        runtimeRevision: 0,
      },
    });
  });

  afterAll(async () => {
    await db.interviewSession.deleteMany({ where: { id: sessionId } }).catch(() => {});
  });

  it("Generates spoken-first text with no visual markdown, symbols, or abbreviations", async () => {
    const req = new Request("http://localhost/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${runtimeToken}`,
      },
      body: JSON.stringify({
        messages: [
          { role: "assistant", content: "Welcome. Can you describe your recent engineering contributions?" },
          {
            role: "user",
            content: "We increased throughput by 80% and saved $50,000 using Redis e.g. for caching vs postgres direct queries.",
          },
        ],
        stream: false,
      }),
    });

    const res = await handleCompletions(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const content = body.choices?.[0]?.message?.content ?? "";

    console.log("\n[SPOKEN-FIRST PROMPT OUTPUT]:\n", content, "\n");

    // 1. Spoken compliance: NO markdown symbols
    expect(content).not.toContain("**");
    expect(content).not.toContain("`");
    expect(content).not.toContain("#");
    expect(content).not.toMatch(/^[-*•]\s+/m);

    // 2. Spoken compliance: NO raw dollar amounts or percentage symbols
    expect(content).not.toContain("$");
    expect(content).not.toContain("%");

    // 3. Spoken compliance: NO unexpanded Latinisms
    expect(content.toLowerCase()).not.toContain("e.g.");
    expect(content.toLowerCase()).not.toContain("i.e.");
    expect(content.toLowerCase()).not.toContain("vs.");

    // 4. Turn conciseness
    const words = content.trim().split(/\s+/).length;
    expect(words).toBeLessThanOrEqual(65);
  }, 45000);

  it("Deictically anchors speech to the active workspace surface", async () => {
    const req = new Request("http://localhost/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${runtimeToken}`,
      },
      body: JSON.stringify({
        messages: [
          { role: "assistant", content: "Welcome. Can you describe your recent engineering contributions?" },
          {
            role: "user",
            content: "I implemented Redis caching instead of relying on direct Postgres queries.",
          },
          {
            role: "assistant",
            content: "Can you describe the specific problem or challenge that led you to implement Redis caching?",
          },
          {
            role: "user",
            content: "I've written the token bucket rate limiter code in the editor here on screen, take a look.",
          },
        ],
        stream: false,
      }),
    });

    const res = await handleCompletions(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const content = body.choices?.[0]?.message?.content ?? "";

    console.log("\n[DEICTIC ANCHORING OUTPUT]:\n", content, "\n");

    const lower = content.toLowerCase();
    const anchorsToSurface =
      lower.includes("code") ||
      lower.includes("editor") ||
      lower.includes("screen") ||
      lower.includes("implementation") ||
      lower.includes("look") ||
      lower.includes("written");

    expect(anchorsToSurface).toBe(true);
  }, 45000);
});
