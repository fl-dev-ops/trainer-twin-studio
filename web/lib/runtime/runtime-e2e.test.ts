import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { db } from "@/lib/db";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { explicitCommunicationRecovery, handleCompletions } from "./openai";
import { GET as getSessionSnapshot } from "@/app/api/sessions/[id]/route";

const tokenHash = (t: string) => createHash("sha256").update(t).digest("hex");
const DATA_DIR = path.resolve(import.meta.dir, "../../data");

function loadConfig(agentSlug = "resume-mastery", personaSlug = "vasanth") {
  const agentYaml = fs.readFileSync(path.join(DATA_DIR, `agents/${agentSlug}.yaml`), "utf8");
  const personaYaml = fs.readFileSync(path.join(DATA_DIR, `personas/${personaSlug}.yaml`), "utf8");
  const agentData = (yaml.load(agentYaml) as any).agent;
  const personaData = (yaml.load(personaYaml) as any).persona;
  const domainYaml = fs.readFileSync(path.join(DATA_DIR, `domains/${agentData.domain}.yaml`), "utf8");
  const domainData = (yaml.load(domainYaml) as any).domain;

  return {
    persona: { version: personaData.version ?? 1, data: personaData },
    agent: { version: agentData.version ?? 1, data: agentData },
    domain: { version: domainData.version ?? 1, data: domainData },
    knowledgeBases: [],
    personaVoiceAvailable: false,
  };
}

describe("Interview Runtime Pipeline", () => {
  it("recognizes communication recovery without grading", () => {
    for (const text of [
      "Sorry, can you repeat your question?",
      "I couldn't hear you clearly. Can you speak slower?",
      "Hello? Are you there?",
    ]) {
      const direction = explicitCommunicationRecovery(text);
      expect(direction?.learner_intent).toBe("clarification");
      expect(direction?.should_grade).toBe(false);
    }
    expect(explicitCommunicationRecovery("We finished the migration last week.")).toBeNull();
  });
});

describe("Interview Runtime End-to-End Suite", () => {
  let orgId = "";
  let userId = "";
  let agentId = "";
  let sessionId = `test-sess-${randomBytes(4).toString("hex")}`;
  let runtimeToken = `test-token-${randomBytes(16).toString("hex")}`;

  const config = loadConfig("resume-mastery", "vasanth");
  // Equip first stage with coding_sandbox so it exercises the surface tool loop
  config.agent.data.stages[0].config.tools = [
    { id: "coding_sandbox", language: "python" },
  ];

  beforeAll(async () => {
    const existingAgent = await db.agent.findFirstOrThrow();
    agentId = existingAgent.id;
    orgId = existingAgent.orgId!;

    const existingMember = await db.member.findFirstOrThrow({
      where: { organizationId: orgId },
    });
    userId = existingMember.userId;

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
        compiledSnapshot: config,
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
        },
        runtimeRevision: 0,
      },
    });
  });

  afterAll(async () => {
    await db.interviewSession.deleteMany({ where: { id: sessionId } });
  });

  it("1. Rejects missing or invalid runtime tokens with 401", async () => {
    const unauthReq = new Request("http://localhost/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    const res = await handleCompletions(unauthReq);
    expect(res.status).toBe(401);

    const badTokenReq = new Request("http://localhost/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer bad-token-xyz",
      },
      body: JSON.stringify({ messages: [] }),
    });
    const badRes = await handleCompletions(badTokenReq);
    expect(badRes.status).toBe(401);
  });

  it("2. Opening turn: emits surface tool call when phase requires surface", async () => {
    const req = new Request("http://localhost/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${runtimeToken}`,
      },
      body: JSON.stringify({
        messages: [{ role: "developer", content: "session-start" }],
        tools: [
          { type: "function", function: { name: "surface" } },
          { type: "function", function: { name: "finish_session" } },
        ],
        stream: false,
      }),
    });

    const res = await handleCompletions(req);
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;

    expect(json.choices[0].finish_reason).toBe("tool_calls");
    const toolCall = json.choices[0].message.tool_calls[0];
    expect(toolCall.function.name).toBe("surface");
    const args = JSON.parse(toolCall.function.arguments);
    expect(args.action).toBe("open_code_editor");
  });

  it("3. Tool response turn: emits opening speech after surface tool execution", async () => {
    const req = new Request("http://localhost/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${runtimeToken}`,
      },
      body: JSON.stringify({
        messages: [
          { role: "developer", content: "session-start" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_surface_0",
                type: "function",
                function: { name: "surface", arguments: "{}" },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "call_surface_0",
            content: JSON.stringify({ status: "ok" }),
          },
        ],
        tools: [
          { type: "function", function: { name: "surface" } },
          { type: "function", function: { name: "finish_session" } },
        ],
        stream: false,
      }),
    });

    const res = await handleCompletions(req);
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;

    expect(json.choices[0].finish_reason).toBe("stop");
    expect(json.choices[0].message.content).toBe(config.agent.data.opening);
    expect(json.choices[0].message.content).not.toBe(config.agent.data.stages[0].opening);

    // Verify DB state
    const session = await db.interviewSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.runtimeRevision).toBeGreaterThanOrEqual(1);
    const transcript = session.transcript as any[];
    expect(transcript.length).toBeGreaterThan(0);
    expect(transcript[transcript.length - 1].role).toBe("trainer");
    const state = session.runtimeState as any;
    expect(state.pending_question).toBe(config.agent.data.opening);
    expect(state.pending_evidence_key).toBeTruthy();
  });

  it("4. Idempotency: replaying identical request returns cached body without re-execution", async () => {
    const reqBody = {
      messages: [
        { role: "developer", content: "session-start" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_surface_0",
              type: "function",
              function: { name: "surface", arguments: "{}" },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_surface_0",
          content: JSON.stringify({ status: "ok" }),
        },
      ],
      tools: [
        { type: "function", function: { name: "surface" } },
        { type: "function", function: { name: "finish_session" } },
      ],
      stream: false,
    };

    const req1 = new Request("http://localhost/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${runtimeToken}`,
      },
      body: JSON.stringify(reqBody),
    });

    const res1 = await handleCompletions(req1);
    expect(res1.headers.get("x-idempotent-replay")).toBe("true");
    const json1 = (await res1.json()) as any;
    expect(json1.choices[0].message.content).toBeTruthy();
  });

  it("5. Repeat requests preserve the pending question without spending a learner turn", async () => {
    const before = await db.interviewSession.findUniqueOrThrow({ where: { id: sessionId } });
    const beforeState = before.runtimeState as any;
    const req = new Request("http://localhost/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${runtimeToken}`,
      },
      body: JSON.stringify({
        messages: [
          { role: "developer", content: "session-start" },
          { role: "assistant", content: config.agent.data.opening },
          { role: "user", content: "Sorry, can you repeat your question?" },
        ],
        stream: false,
      }),
    });

    const res = await handleCompletions(req);
    const json = (await res.json()) as any;
    expect(json.choices[0].message.content).toBe(config.agent.data.opening);

    const after = await db.interviewSession.findUniqueOrThrow({ where: { id: sessionId } });
    const afterState = after.runtimeState as any;
    expect(afterState.learner_turns).toBe(beforeState.learner_turns);
    expect(afterState.phase_turns).toBe(beforeState.phase_turns);
    expect(afterState.pending_question).toBe(config.agent.data.opening);
  });

  it("6. Snapshot route GET /api/sessions/[id]: returns authoritative state and coverage", async () => {
    const req = new Request(`http://localhost/api/sessions/${sessionId}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${runtimeToken}`,
      },
    });

    const res = await getSessionSnapshot(req, { params: Promise.resolve({ id: sessionId }) });
    expect(res.status).toBe(200);
    const snap = (await res.json()) as any;

    expect(snap.id).toBe(sessionId);
    expect(snap.status).toBe("active");
    expect(typeof snap.coverage).toBe("object");
    expect(snap.phase_index).toBe(0);
    expect(snap.runtimeRevision).toBeGreaterThanOrEqual(1);
  });
});
