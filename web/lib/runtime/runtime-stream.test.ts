/**
 * SSE streaming contract tests for POST /api/v1/chat/completions.
 * Frames are asserted against LiveKit's inference LLMStream parser
 * (livekit/agents/inference/llm.py): `data: {...}\n\n` chunks, a final chunk
 * carrying `usage` (choices may be empty), and `data: [DONE]\n\n` terminator.
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { db } from "@/lib/db";
import { createHash, randomBytes } from "node:crypto";
import { handleCompletions } from "./openai";

const tokenHash = (t: string) => createHash("sha256").update(t).digest("hex");

interface SseChunk {
  id?: string;
  object?: string;
  model?: string;
  choices?: Array<{
    index?: number;
    delta?: { role?: string; content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

function parseSse(raw: string): SseChunk[] {
  const frames = raw.split("\n\n").filter((f) => f.startsWith("data: "));
  return frames.map((frame) => {
    const payload = frame.slice("data: ".length);
    return payload === "[DONE]" ? { object: "[DONE]" } : (JSON.parse(payload) as SseChunk);
  });
}

async function readSse(res: Response): Promise<string> {
  return await res.text();
}

describe("SSE Streaming Contract (LiveKit openai.LLM parity)", () => {
  let orgId = "";
  let userId = "";
  let agentId = "";
  let sessionId = `test-stream-${randomBytes(4).toString("hex")}`;
  let runtimeToken = `stream-token-${randomBytes(16).toString("hex")}`;

  const config = {
    persona: { version: 1, data: { id: "vasanth", version: 1 } },
    agent: { version: 1, data: null as unknown as Record<string, unknown> },
    domain: { version: 1, data: null as unknown as Record<string, unknown> },
    knowledgeBases: [],
    personaVoiceAvailable: false,
  };

  beforeAll(async () => {
    // Reuse the same fixture loading as the e2e suite
    const fs = await import("node:fs");
    const path = await import("node:path");
    const yaml = (await import("js-yaml")).default;
    const DATA_DIR = path.resolve(import.meta.dir, "../../data");
    const agentData = (yaml.load(
      fs.readFileSync(path.join(DATA_DIR, "agents/resume-mastery.yaml"), "utf8")
    ) as any).agent;
    const personaData = (yaml.load(
      fs.readFileSync(path.join(DATA_DIR, "personas/vasanth.yaml"), "utf8")
    ) as any).persona;
    const domainData = (yaml.load(
      fs.readFileSync(path.join(DATA_DIR, "domains/software-engineering-resume.yaml"), "utf8")
    ) as any).domain;
    config.persona.data = personaData;
    config.agent.data = agentData;
    config.domain.data = domainData;

    const existingAgent = await db.agent.findFirstOrThrow();
    agentId = existingAgent.id;
    orgId = existingAgent.orgId!;
    const member = await db.member.findFirstOrThrow({ where: { organizationId: orgId } });
    userId = member.userId;

    await db.interviewSession.create({
      data: {
        id: sessionId,
        orgId,
        userId,
        agentId,
        shareCode: randomBytes(8).toString("hex"),
        runtimeTokenHash: tokenHash(runtimeToken),
        personaSlug: "vasanth",
        personaVersion: 1,
        agentSlug: "resume-mastery",
        agentVersion: 1,
        domainSlug: "software-engineering-resume",
        domainVersion: 1,
        status: "active",
        compiledSnapshot: config,
        runtimeState: {
          phase_index: 0,
          phase_turns: 0,
          learner_turns: 0,
          coverage: {},
          claims: [],
          evidence_probe_counts: {},
          pending_evidence_key: null,
          pending_question: null,
          actions: [],
          grounding_probes: [],
          grounding_probe_counts: {},
          current_surface: null,
        },
        runtimeRevision: 0,
      },
    });
  });

  afterAll(async () => {
    await db.interviewSession.deleteMany({ where: { id: sessionId } });
  });

  async function post(body: Record<string, unknown>, token = runtimeToken) {
    return handleCompletions(
      new Request("http://localhost/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      })
    );
  }

  it("streams framed SSE chunks with a final usage chunk and [DONE] terminator", async () => {
    const res = await post({
      messages: [
        { role: "developer", content: "session-start" },
        { role: "user", content: "Hello, I'm ready to start the interview." },
      ],
      stream: true,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const raw = await readSse(res);
    const chunks = parseSse(raw);

    // Framing: every frame is a chunk object, exactly one [DONE] terminator last
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[chunks.length - 1].object).toBe("[DONE]");
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.object).toBe("chat.completion.chunk");
      expect(chunk.id).toMatch(/^chatcmpl-/);
      expect(chunk.model).toBe("trainertwin-runtime");
      expect(Array.isArray(chunk.choices)).toBe(true);
    }

    // Final chunk is the usage event: empty choices, numeric token counts
    const usageChunk = chunks[chunks.length - 2];
    expect(usageChunk.choices).toEqual([]);
    expect(typeof usageChunk.usage?.prompt_tokens).toBe("number");
    expect(typeof usageChunk.usage?.completion_tokens).toBe("number");
    expect(usageChunk.usage!.total_tokens).toBe(
      usageChunk.usage!.prompt_tokens + usageChunk.usage!.completion_tokens
    );

    // Assistant content chunks precede it, ending with finish_reason stop
    const contentChunks = chunks.slice(0, -2);
    expect(contentChunks.some((c) => c.choices?.[0]?.delta?.content)).toBe(true);
    expect(contentChunks[contentChunks.length - 1].choices?.[0]?.finish_reason).toBe("stop");
 }, 120_000);


  it("non-stream responses include a top-level usage object", async () => {
    const res = await post({
      messages: [
        { role: "developer", content: "session-start" },
        { role: "assistant", content: "We'll start now." },
        { role: "user", content: "Sure, please go ahead and ask your first question." },
      ],
      stream: false,
    });
    const json = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(typeof json.usage?.prompt_tokens).toBe("number");
    expect(typeof json.usage?.completion_tokens).toBe("number");
    expect(json.usage.total_tokens).toBe(
      json.usage.prompt_tokens + json.usage.completion_tokens
    );
 }, 120_000);


  it("idempotent replay returns the identical stream including the usage chunk", async () => {
    const body = {
      messages: [
        { role: "developer", content: "session-start" },
        { role: "assistant", content: "We'll start now." },
        { role: "user", content: "I have a solid answer about my most recent project, ready when you are." },
      ],
      stream: true,
    };
    const res1 = await post(body);
    const raw1 = await readSse(res1);
    const chunks1 = parseSse(raw1);
    expect(res1.headers.get("x-idempotent-replay")).toBeNull();

    const res2 = await post(body);
    expect(res2.headers.get("x-idempotent-replay")).toBe("true");
    const chunks2 = parseSse(await readSse(res2));

    expect(chunks2).toEqual(chunks1);
    expect(chunks2[chunks2.length - 2].usage).toEqual(chunks1[chunks1.length - 2].usage);
 }, 120_000);

});
