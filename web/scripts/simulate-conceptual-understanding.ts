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
  console.log("=== SIMULATING SCENARIO: conceptual-understanding ===");

  const agent = await db.agent.findFirst({
    where: { slug: AGENT_SLUG },
    include: { persona: true },
  });
  if (!agent) throw new Error(`Agent ${AGENT_SLUG} not found`);

  const member = await db.organizationMember.findFirst({
    where: { organizationId: agent.orgId },
  });
  if (!member) throw new Error(`No member found for org ${agent.orgId}`);

  console.log(`Compiling agent config for: ${AGENT_SLUG}`);
  const compiledConfig = await getAgentConfigForAgent(agent.id, agent.orgId);

  const sessionId = `sim-concept-${randomBytes(6).toString("hex")}`;
  const runtimeToken = randomBytes(16).toString("hex");
  const tokenHash = createHash("sha256").update(runtimeToken).digest("hex");

  console.log(`Creating ephemeral session: ${sessionId} (org: ${agent.orgId}, user: ${member.userId})`);

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
      status: "active",
      runtimeTokenHash: tokenHash,
      compiledSnapshot: compiledConfig ? (JSON.parse(JSON.stringify(compiledConfig)) as Prisma.InputJsonValue) : undefined,
      runtimeState: {},
      runtimeRevision: 0,
    },
  });

  const capturedSurfaces: Array<{ commandId: string; surface: AgentSurface; action: string }> = [];
  let polling = true;

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
            console.log(`\n[BROWSER CONSUMER] Intercepted surface command ${cmd.id}: action=${action}`);
            if (parsed) {
              console.log(`[BROWSER CONSUMER] Parsed surface: tool=${parsed.surface?.tool}, key=${parsed.surface?.key}, questionId=${parsed.surface?.questionId}, readOnly=${parsed.surface?.readOnly}`);
              if (parsed.surface?.tool === "code") {
                console.log(`[BROWSER CONSUMER] Code starterCode preview: "${parsed.surface.starterCode?.slice(0, 60)}..." (len: ${parsed.surface.starterCode?.length})`);
              }
              capturedSurfaces.push({ commandId: cmd.id, surface: parsed.surface, action });
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
    console.log(`\n--- SENDING USER TURN ---`);
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
    return text;
  }

  try {
    // Turn 0: opening
    await sendTurn("session-start", true);
    await Bun.sleep(1000);

    // Turn 1: Candidate greetings
    await sendTurn("Hello Vasanth! Glad to be here today. I'm ready to discuss JavaScript and React fundamentals.");
    await Bun.sleep(1000);

    // Turn 2: Candidate prompts for question
    await sendTurn("I'm comfortable with closures, the event loop, React hooks, and rendering lifecycles. Please feel free to test me on any code snippet or coding challenge.");
    await Bun.sleep(1000);

    // Turn 3: Candidate answers the first question (e.g. code-output or conceptual)
    await sendTurn("In the first phase, layout effects run synchronously before paint, while standard effects run asynchronously after paint. So useLayoutEffect logs first, then useEffect.");
    await Bun.sleep(1000);

    // Turn 4: Candidate asks for the coding challenge
    await sendTurn("Understood. I'm ready for the next problem. Let's write the code for the implementation challenge in the editor.");
    await Bun.sleep(1000);

  } finally {
    polling = false;
    await consumerPromise;

    console.log("\n================ SIMULATION RESULTS ================");
    console.log(`Total surface commands intercepted: ${capturedSurfaces.length}`);
    for (let i = 0; i < capturedSurfaces.length; i++) {
      const s = capturedSurfaces[i];
      console.log(`\nSurface [${i + 1}]:`);
      console.log(`  Action: ${s.action}`);
      console.log(`  Tool: ${s.surface?.tool}`);
      console.log(`  Key: ${s.surface?.key}`);
      console.log(`  QuestionId: ${s.surface?.questionId}`);
      console.log(`  ReadOnly: ${s.surface?.readOnly}`);
      if (s.surface?.tool === "code") {
        console.log(`  StarterCode: "${s.surface.starterCode?.slice(0, 60)}..." (length: ${s.surface.starterCode?.length})`);
      }
    }

    const codeSurfaces = capturedSurfaces.filter((s) => s.surface?.tool === "code");
    if (codeSurfaces.length >= 2) {
      const s1 = codeSurfaces[0];
      const s2 = codeSurfaces[1];
      console.log("\n--- Checking transition between code surfaces ---");
      console.log(`Surface 1 Key: ${s1.surface?.key}`);
      console.log(`Surface 2 Key: ${s2.surface?.key}`);
      const keysDistinct = s1.surface?.key !== s2.surface?.key;
      console.log(`Keys are distinct: ${keysDistinct} (React remount triggered: ${keysDistinct})`);
      console.log(`Surface 1 ReadOnly: ${s1.surface?.readOnly}`);
      console.log(`Surface 2 ReadOnly: ${s2.surface?.readOnly}`);
      console.log(`Surface 2 StarterCode is blank: ${s2.surface?.starterCode === "" || s2.surface?.starterCode?.trim().length === 0}`);
    }

    // Cleanup session and commands
    console.log(`\nCleaning up ephemeral session ${sessionId}...`);
    await db.workspaceCommand.deleteMany({ where: { sessionId } });
    await db.interviewSession.delete({ where: { id: sessionId } });
    console.log("Cleanup done.");
  }
}

main().catch((err) => {
  console.error("Simulation failed:", err);
  process.exit(1);
});
