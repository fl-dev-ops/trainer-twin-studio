// One-off verification of the uiState ledger (Phase 1) — run with: bun scripts/verify-ui-state.ts
// 1. Writes uiState into a session's runtimeState (simulating the browser POST)
// 2. Reads it back through the studio bridge getSessionContext
// 3. Formats a session spec through the brain and checks the screen-state block
import "dotenv/config";
import { db } from "../lib/db";
import { POST as studioPOST } from "../app/api/copilot/studio/route";
import { POST as uiStatePOST, GET as uiStateGET } from "../app/api/sessions/[id]/ui-state/route";
import { formatSessionSpec, loadSessionContext } from "../../chat/agent/lib/brain";

function fail(message: string): never {
  console.error("✗", message);
  process.exit(1);
}

async function main() {
  const secret = process.env.COPILOT_SERVICE_SECRET;
  if (!secret) throw new Error("COPILOT_SERVICE_SECRET not configured");

  const org = await db.organization.findFirst({ select: { id: true, slug: true } });
  if (!org) throw new Error("No organization found");

  // Use the latest session; fabricate a runtime token for the ui-state route by
  // writing the hash directly (the browser normally holds the plaintext token).
  const session = await db.interviewSession.findFirst({
    where: { orgId: org.id, status: { in: ["assigned", "active"] } },
    orderBy: { createdAt: "desc" },
    select: { id: true, agentSlug: true },
  });
  if (!session) throw new Error("No assigned/active session found to test with");

  const runtimeToken = `test-ui-state-${Date.now()}`;
  const { createHash } = await import("node:crypto");
  const tokenHash = (t: string) => createHash("sha256").update(t).digest("hex");
  await db.interviewSession.update({
    where: { id: session.id },
    data: { runtimeTokenHash: tokenHash(runtimeToken) },
  });
  console.log("Session:", session.id, "org:", org.slug);

  const routeContext = { params: Promise.resolve({ id: session.id }) };
  const authHeaders = { authorization: `Bearer ${runtimeToken}`, "content-type": "application/json" };

  // --- Step 1: browser opens the code editor ---
  const openRes = await uiStatePOST(
    new Request("http://localhost:3000", { method: "POST", headers: authHeaders, body: JSON.stringify({ active: "code", key: "test-key-1" }) }),
    routeContext,
  );
  if (openRes.status !== 200) fail(`ui-state POST failed: ${openRes.status} ${await openRes.text()}`);
  console.log("✓ POST ui-state (code open) →", JSON.stringify((await openRes.json()).uiState));

  // --- Step 2: user closes the editor (active: null) ---
  const closeRes = await uiStatePOST(
    new Request("http://localhost:3000", { method: "POST", headers: authHeaders, body: JSON.stringify({ active: null }) }),
    routeContext,
  );
  if (closeRes.status !== 200) fail(`ui-state close POST failed: ${closeRes.status}`);
  console.log("✓ POST ui-state (closed) →", JSON.stringify((await closeRes.json()).uiState));

  // --- Step 3: read back via GET ---
  const getRes = await uiStateGET(new Request("http://localhost:3000", { headers: authHeaders }), routeContext);
  const stored = (await getRes.json()).uiState;
  if (stored?.active !== null) fail(`GET ui-state returned unexpected state: ${JSON.stringify(stored)}`);
  console.log("✓ GET ui-state round-trips closed state");

  // --- Step 4: unauthorized request is rejected ---
  const unauthRes = await uiStatePOST(
    new Request("http://localhost:3000", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ active: "code" }) }),
    routeContext,
  );
  if (unauthRes.status !== 401) fail(`unauthorized POST not rejected (got ${unauthRes.status})`);
  console.log("✓ POST without runtime token → 401");

  // --- Step 5: studio bridge returns uiState in getSessionContext ---
  const ctxReq = new Request("http://localhost:3000/api/copilot/studio", {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json", "x-trainertwin-org-id": org.id },
    body: JSON.stringify({ action: "getSessionContext", sessionId: session.id, agentSlug: session.agentSlug ?? "interview" }),
  });
  const ctxRes = await studioPOST(ctxReq);
  if (ctxRes.status !== 200) fail(`getSessionContext failed: ${ctxRes.status} ${await ctxRes.text()}`);
  const ctx = await ctxRes.json();
  if (!ctx.uiState || ctx.uiState.active !== null) fail(`getSessionContext missing uiState: ${JSON.stringify(ctx.uiState)}`);
  console.log("✓ getSessionContext returns uiState:", JSON.stringify(ctx.uiState));

  // --- Step 6: brain formats the spec with the screen-state block ---
  const specs = await loadSessionContext(org.id, session.id, session.agentSlug ?? "interview", undefined, "voice");
  const specText = formatSessionSpec(specs);
  if (!specText.includes("CURRENT SCREEN STATE")) fail("formatSessionSpec missing CURRENT SCREEN STATE block");
  if (!specText.includes("no workspace panel is open")) fail("spec does not reflect closed panel");
  console.log("✓ formatSessionSpec injects CURRENT SCREEN STATE (panel: NONE)");
  console.log("\n--- Injected block preview ---");
  const block = specText.split("CURRENT SCREEN STATE")[1]?.split("ATTACHED ARTIFACTS")[0] ?? "";
  console.log("CURRENT SCREEN STATE" + block.trimEnd().split("\nSCREEN-STATE RULES")[0]);

  console.log("\nAll uiState ledger checks passed.");
}

main().catch((err) => {
  console.error("verification failed:", err);
  process.exit(1);
});
