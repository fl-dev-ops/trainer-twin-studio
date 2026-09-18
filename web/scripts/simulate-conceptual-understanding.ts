import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { getAgentConfigForAgent } from "@/lib/specs";
import { parseWorkspaceCommandSurface } from "@/lib/livekit-workspaces";
import {
  listPendingWorkspaceCommands,
  completeWorkspaceCommand,
} from "@/lib/workspace-commands";
import type { AgentSurface } from "@/lib/agent-surface-events";
import type { Prisma } from "@/lib/generated/prisma/client";

const CHAT_URL = process.env.BENCH_API_URL || process.env.CHAT_URL || "http://localhost:2000";
const SECRET = process.env.COPILOT_SERVICE_SECRET || "";
const AGENT_SLUG = "conceptual-understanding";
const PERSONA_SLUG = "Vasanth";

const DEFAULT_TOOLS = [
  {
    type: "function",
    function: {
      name: "surface",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string" },
          payload: { type: "object" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finish_session",
      parameters: { type: "object", properties: {} },
    },
  },
];

async function main() {
  console.log("=== EXECUTABLE SIMULATION: conceptual-understanding (code-output -> coding) ===");

  const agent = await db.agent.findFirst({
    where: { slug: AGENT_SLUG },
    include: { persona: true },
  });
  if (!agent) throw new Error(`Agent ${AGENT_SLUG} not found`);

  const member = await db.member.findFirst({
    where: { organizationId: agent.orgId },
  });
  if (!member) throw new Error(`No member found for org ${agent.orgId}`);

  console.log(`Compiling agent config for: ${AGENT_SLUG}`);
  const compiledConfig = await getAgentConfigForAgent(agent.id, agent.orgId);
  const sessionConfig = compiledConfig
    ? (JSON.parse(JSON.stringify(compiledConfig)) as Record<string, unknown>)
    : {};
  const agentObj = sessionConfig.agent as Record<string, unknown> | undefined;
  const agentData = agentObj?.data as Record<string, unknown> | undefined;
  const configObj = agentData?.config as Record<string, unknown> | undefined;
  const interviewObj = configObj?.interview as Record<string, unknown> | undefined;
  if (interviewObj) {
    interviewObj.question_counts = {
      "code-output": 1,
      coding: 1,
    };
  }

  const sessionId = `sim-concept-${randomBytes(6).toString("hex")}`;
  const runtimeToken = randomBytes(16).toString("hex");
  const tokenHash = createHash("sha256").update(runtimeToken).digest("hex");

  console.log(`Creating ephemeral session: ${sessionId} (org: ${agent.orgId}, user: ${member.userId})`);
  console.log("Configured question_counts for simulation:", interviewObj?.question_counts);
  const capturedSurfaces: Array<{
    turnIndex: number;
    commandId: string;
    surface: AgentSurface;
    action: string;
  }> = [];
  let polling = true;
  let currentTurnIndex = 0;

  try {
    await db.interviewSession.create({
      data: {
        id: sessionId,
        orgId: agent.orgId,
        userId: member.userId,
        agentId: agent.id,
        personaSlug: agent.persona.slug,
        personaVersion: agent.persona.version,
        agentSlug: agent.slug,
        agentVersion: agent.version,
        domainSlug: agent.domainSlug,
        domainVersion: 1,
        shareCode: randomBytes(9).toString("hex"),
        status: "active",
        runtimeTokenHash: tokenHash,
        compiledSnapshot: sessionConfig as unknown as Prisma.InputJsonValue,
        runtimeState: {},
        runtimeRevision: 0,
      },
    });

    // Background consumer standing in for browser / LiveKitWorkspaceProvider
    const consumerPromise = (async () => {
      while (polling) {
        try {
          const pending = await listPendingWorkspaceCommands(sessionId);
          for (const cmd of pending) {
            if (cmd.tool === "surface") {
              const parsed = parseWorkspaceCommandSurface(cmd as { id: string; tool: string; input: unknown });
              const input = (cmd.input && typeof cmd.input === "object" ? cmd.input : {}) as Record<string, unknown>;
              const action = String(input.action ?? input.type ?? "");
              console.log(`\n[BROWSER CONSUMER] (Turn ${currentTurnIndex}) Intercepted surface command ${cmd.id}: action=${action}`);
              if (parsed) {
                console.log(`[BROWSER CONSUMER] Parsed surface: tool=${parsed.surface?.tool}, key=${parsed.surface?.key}, questionId=${parsed.surface?.questionId}, readOnly=${parsed.surface?.readOnly}`);
                if (parsed.surface?.tool === "code") {
                  console.log(`[BROWSER CONSUMER] Code starterCode preview: "${parsed.surface.starterCode?.slice(0, 60)}..." (len: ${parsed.surface.starterCode?.length})`);
                }
                capturedSurfaces.push({
                  turnIndex: currentTurnIndex,
                  commandId: cmd.id,
                  surface: parsed.surface,
                  action,
                });
              }
              await completeWorkspaceCommand(sessionId, cmd.id, { ok: true, action });
            } else {
              console.log(`[BROWSER CONSUMER] Auto-acknowledging command ${cmd.tool} (${cmd.id})`);
              await completeWorkspaceCommand(sessionId, cmd.id, { ok: true });
            }
          }
        } catch (err) {
          console.error("Error in command consumer:", err);
        }
        await Bun.sleep(200);
      }
    })();

    const b64Auth = Buffer.from(`${agent.orgId}:${SECRET}`).toString("base64");
    const headers = {
      "content-type": "application/json",
      Authorization: `Basic ${b64Auth}`,
      "x-trainertwin-session-id": sessionId,
      "x-trainertwin-org-id": agent.orgId,
      "x-trainertwin-agent-slug": AGENT_SLUG,
      "x-trainertwin-persona-slug": PERSONA_SLUG,
    };

    async function sendTurn(userContent: string, isOpening = false) {
      console.log(`\n--- SENDING TURN ${currentTurnIndex} ---`);
      console.log(`User says: "${userContent}"`);
      const res = await fetch(`${CHAT_URL}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "trainertwin-brain",
          stream: true,
          tools: DEFAULT_TOOLS,
          messages: [{ role: isOpening ? "developer" : "user", content: userContent }],
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Chat request failed (${res.status}): ${errText}`);
      }

      let text = "";
      const rawText = await res.text();
      for (const line of rawText.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ") || trimmed === "data: [DONE]") continue;
        try {
          const chunk = JSON.parse(trimmed.slice(6)) as { choices?: Array<{ delta?: { content?: string } }> };
          const content = chunk.choices?.[0]?.delta?.content;
          if (content) text += content;
        } catch {}
      }

      console.log(`Trainer response: "${text}"`);
      currentTurnIndex += 1;
      return text;
    }

    // Turn 0: Opening turn
    await sendTurn("session-start", true);
    await Bun.sleep(1200);

    // Turn 1: Candidate greeting and steering to code questions
    await sendTurn("Hello Vasanth! Glad to be here. I'm a frontend JavaScript engineer and I'm ready to begin with our code snippet analysis questions.");
    await Bun.sleep(1200);

    // Turn 2: If trainer opened whiteboard, request switching to code editor
    const lastSurfaceIsCanvas = capturedSurfaces[capturedSurfaces.length - 1]?.surface?.tool === "canvas";
    await sendTurn(
      lastSurfaceIsCanvas
        ? "Understood, but could we please start with the code snippet in the code editor first?"
        : "Looking at this snippet, setTimeout is queued in the macrotask queue while promises resolve in the microtask queue, so the promise callback runs before the timeout.",
    );
    await Bun.sleep(1200);

    // Turn 3: Candidate answers or deepens on the code-output question (intervening follow-up)
    await sendTurn("The underlying mechanism is that the event loop completely drains the microtask queue at the end of the current execution context before picking the next macrotask.");
    await Bun.sleep(1200);

    // Turn 4: Candidate moves to the coding challenge
    await sendTurn("Got it, thank you! I am ready for the implementation challenge now. Could you please open the coding challenge in the editor?");
    await Bun.sleep(1500);

    polling = false;
    await consumerPromise;

    console.log("\n================ VERIFYING CAPTURED SURFACES ================");
    const codeSurfaces = capturedSurfaces.filter((s) => s.surface?.tool === "code");
    console.log(`Total code surface events captured: ${codeSurfaces.length}`);

    for (let i = 0; i < codeSurfaces.length; i++) {
      const s = codeSurfaces[i];
      console.log(`  [Code Surface ${i + 1} at Turn ${s.turnIndex}]: key=${s.surface?.key}, readOnly=${s.surface?.readOnly}, starterCodeLen=${s.surface?.starterCode?.length}`);
    }

    // Assertion 1: Must have captured at least 2 code surfaces
    assert.ok(
      codeSurfaces.length >= 2,
      `Expected at least 2 code surface commands across the session, captured ${codeSurfaces.length}`,
    );

    const outputSurfaces = codeSurfaces.filter((s) => s.surface?.readOnly === true);
    const codingSurfaces = codeSurfaces.filter((s) => s.surface?.readOnly === false);

    console.log(`\nFound ${outputSurfaces.length} code-output surface(s) and ${codingSurfaces.length} coding surface(s).`);

    assert.ok(outputSurfaces.length >= 1, "Must have captured at least one code-output surface (readOnly: true)");
    assert.ok(codingSurfaces.length >= 1, "Must have captured at least one coding surface (readOnly: false)");

    const lastOutput = outputSurfaces[outputSurfaces.length - 1];
    const firstCoding = codingSurfaces[0];

    // Verify code-output has non-empty code snippet
    assert.ok(
      typeof lastOutput.surface?.starterCode === "string" && lastOutput.surface.starterCode.trim().length > 0,
      "Code-output surface must contain non-empty code snippet",
    );

    // Verify coding has readOnly: false
    assert.strictEqual(firstCoding.surface?.readOnly, false, "Coding surface must be readOnly: false");

    // Verify chronological order: coding question is posed after code-output
    assert.ok(
      lastOutput.turnIndex < firstCoding.turnIndex,
      `Coding surface (Turn ${firstCoding.turnIndex}) must be posed after code-output surface (Turn ${lastOutput.turnIndex})`,
    );

    // Verify key distinction so React remounts <CodeEditor>
    assert.notStrictEqual(
      lastOutput.surface?.key,
      firstCoding.surface?.key,
      `Surface keys must be distinct between code-output (${lastOutput.surface?.key}) and coding (${firstCoding.surface?.key})`,
    );

    console.log("\n>>> ALL VERIFICATION CHECKS PASSED SUCCESSFULLY! <<<");
    console.log(`Verified transition: ${lastOutput.surface?.key} (readOnly: true) -> ${firstCoding.surface?.key} (readOnly: false)`);
    console.log("React remount is guaranteed by distinct keys, opening the new editor properly.");

  } finally {
    // Outer finally ensures cleanup runs unconditionally, even on assertion failures
    polling = false;
    console.log(`\nCleaning up ephemeral session ${sessionId}...`);
    await db.workspaceCommand.deleteMany({ where: { sessionId } }).catch(() => {});
    await db.interviewSession.delete({ where: { id: sessionId } }).catch(() => {});
    console.log("Cleanup complete.");
  }
}

main().catch((err) => {
  console.error("\nSimulation failed:", err);
  process.exit(1);
});
