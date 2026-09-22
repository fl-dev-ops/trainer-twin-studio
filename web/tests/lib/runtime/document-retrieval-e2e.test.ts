import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { randomBytes, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { db } from "@/lib/db";
import { handleCompletions } from "../../../lib/runtime/openai";

const DATA_DIR = path.resolve(import.meta.dir, "../../../data");

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

describe("Document On-Demand Retrieval E2E Live Flow", () => {
  let orgId: string;
  let userId: string;
  let agentId: string;
  let docId = `test-doc-${randomBytes(4).toString("hex")}`;
  let sessionId = `test-sess-doc-${randomBytes(4).toString("hex")}`;
  let runtimeToken = `test-token-${randomBytes(16).toString("hex")}`;

  beforeAll(async () => {
    const existingAgent = await db.agent.findFirstOrThrow();
    agentId = existingAgent.id;
    orgId = existingAgent.orgId!;

    const existingMember = await db.member.findFirstOrThrow({
      where: { organizationId: orgId },
    });
    userId = existingMember.userId;

    // 1. Create document with unique, non-trivial facts in chunks
    const chunk1Text = "Architected HyperSync: a distributed WAL-based synchronization engine written in Rust that synchronized 500,000 edge databases with a p99 latency of 14ms.";
    const chunk2Text = "Designed zero-downtime cache invalidation across 280 global edge locations using durable objects.";

    await db.contextDocument.create({
      data: {
        id: docId,
        orgId,
        ownerUserId: userId,
        name: "karthik_resume.pdf",
        mimeType: "application/pdf",
        kind: "document",
        size: 1024,
        content: Buffer.from("%PDF-mock-bytes"),
        extractedText: `# HyperSync Engine\n${chunk1Text}\n\n# Edge Invalidation\n${chunk2Text}`,
        manifest: {
          id: docId,
          name: "karthik_resume.pdf",
          kind: "document",
          mimeType: "application/pdf",
          size: 1024,
          pageCount: 2,
          headings: ["HyperSync Engine", "Edge Invalidation"],
          summary: "Sections: HyperSync Engine, Edge Invalidation",
        },
        chunks: {
          create: [
            {
              chunkIndex: 0,
              heading: "HyperSync Engine",
              pageNumber: 1,
              text: chunk1Text,
            },
            {
              chunkIndex: 1,
              heading: "Edge Invalidation",
              pageNumber: 2,
              text: chunk2Text,
            },
          ],
        },
      },
    });

    // 2. Set up compiled config with document manifests
    const baseConfig = loadConfig("resume-mastery", "vasanth");
    const compiledSnapshot = {
      ...baseConfig,
      documentManifests: [
        {
          id: docId,
          name: "karthik_resume.pdf",
          kind: "document",
          mimeType: "application/pdf",
          size: 1024,
          pageCount: 2,
          headings: ["HyperSync Engine", "Edge Invalidation"],
          summary: "Sections: HyperSync Engine, Edge Invalidation",
        },
      ],
      sessionDocumentIds: [docId],
    };

    // 3. Create interview session and link via InterviewSessionDocument
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
        compiledSnapshot,
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
          current_surface: null,
          pending_document_lookup: null,
        },
        runtimeRevision: 0,
        documents: {
          create: [{ documentId: docId }],
        },
      },
    });
  });

  afterAll(async () => {
    await db.interviewSessionDocument.deleteMany({ where: { sessionId } }).catch(() => {});
    await db.interviewSession.deleteMany({ where: { id: sessionId } }).catch(() => {});
    await db.contextDocumentChunk.deleteMany({ where: { documentId: docId } }).catch(() => {});
    await db.contextDocument.deleteMany({ where: { id: docId } }).catch(() => {});
  });

  it("Opening turn adapts with document manifest awareness", async () => {
    const req = new Request("http://localhost/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${runtimeToken}`,
      },
      body: JSON.stringify({
        messages: [],
        stream: false,
      }),
    });

    const res = await handleCompletions(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const content = body.choices?.[0]?.message?.content;
    expect(typeof content).toBe("string");
    expect(content.length).toBeGreaterThan(10);
  }, 20000);

  it("Learner requests HyperSync project -> Agent retrieves chunk and discusses HyperSync specifically", async () => {
    const req = new Request("http://localhost/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${runtimeToken}`,
      },
      body: JSON.stringify({
        messages: [
          { role: "assistant", content: "Welcome. Which project from your resume would you like to dive into?" },
          { role: "user", content: "I would like to discuss my HyperSync project where we built a synchronization engine in Rust." },
        ],
        stream: false,
      }),
    });

    const res = await handleCompletions(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const content = body.choices?.[0]?.message?.content?.toLowerCase() ?? "";

    console.log("\n[E2E TEST] Agent response to HyperSync turn:\n", content, "\n");

    // Verify the agent response has the specific context from the document
    // (HyperSync, Rust, 500,000, WAL, or latency/synchronization)
    const mentionsDocumentFact =
      content.includes("hypersync") ||
      content.includes("rust") ||
      content.includes("wal") ||
      content.includes("500,000") ||
      content.includes("sync");

    expect(mentionsDocumentFact).toBe(true);
  }, 45000);

  it("Learner switches topic to Edge Invalidation -> Agent retrieves Chunk 2 and probes edge cache details", async () => {
    const req = new Request("http://localhost/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${runtimeToken}`,
      },
      body: JSON.stringify({
        messages: [
          { role: "assistant", content: "Welcome. Which project from your resume would you like to dive into?" },
          { role: "user", content: "I would like to discuss my HyperSync project where we built a synchronization engine in Rust." },
          { role: "assistant", content: "Can you describe specifically which parts of the HyperSync engine you personally designed?" },
          { role: "user", content: "Actually, let's switch to my Edge Invalidation project where I handled cache invalidation across 280 edge locations." },
        ],
        stream: false,
      }),
    });

    const res = await handleCompletions(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const content = body.choices?.[0]?.message?.content?.toLowerCase() ?? "";

    console.log("\n[E2E TEST] Agent response to Edge Invalidation turn:\n", content, "\n");

    const mentionsEdgeFact =
      content.includes("edge") ||
      content.includes("invalidation") ||
      content.includes("cache") ||
      content.includes("280") ||
      content.includes("durable");

    expect(mentionsEdgeFact).toBe(true);
  }, 45000);
});
