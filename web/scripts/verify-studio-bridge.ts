import "dotenv/config";
import { db } from "../lib/db";
import { POST } from "../app/api/copilot/studio/route";

async function main() {
  const secret = process.env.COPILOT_SERVICE_SECRET;
  if (!secret) throw new Error("COPILOT_SERVICE_SECRET not configured");

  const org = await db.organization.findFirst({ select: { id: true, slug: true } });
  if (!org) throw new Error("No organization found");

  const session = await db.interviewSession.findFirst({
    where: { orgId: org.id },
    orderBy: { createdAt: "desc" },
    select: { id: true, agentSlug: true, personaSlug: true },
  });

  console.log("Testing studio bridge handler for org:", org.slug, "sessionId:", session?.id);

  // 1. Test getSessionContext
  const ctxReq = new Request("http://localhost:3000/api/copilot/studio", {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
      "x-trainertwin-org-id": org.id,
    },
    body: JSON.stringify({
      action: "getSessionContext",
      sessionId: session?.id,
      agentSlug: session?.agentSlug ?? "project-experience-deep-dive",
    }),
  });

  const ctxRes = await POST(ctxReq);
  console.log("getSessionContext response status:", ctxRes.status);
  if (ctxRes.status === 200) {
    const data = await ctxRes.json();
    console.log("  agent:", data.agent?.slug);
    console.log("  has resume:", Boolean(data.resume));
    if (data.resume) {
      console.log("  claims count:", data.resume.claims?.length, "text length:", data.resume.extractedText?.length);
    }
  } else {
    console.log("  error:", await ctxRes.text());
  }

  // 2. Test searchKnowledge with topics
  const kb = await db.knowledgeBase.findFirst({
    where: { orgId: org.id },
    select: { slug: true },
  });
  if (kb) {
    const kbReq = new Request("http://localhost:3000/api/copilot/studio", {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
        "x-trainertwin-org-id": org.id,
      },
      body: JSON.stringify({
        action: "searchKnowledge",
        knowledgeBase: kb.slug,
        query: "fundamentals JavaScript",
        limit: 2,
        topics: ["javascript", "fundamentals"],
      }),
    });
    const kbRes = await POST(kbReq);
    console.log("searchKnowledge status:", kbRes.status);
    if (kbRes.status === 200) {
      const kbData = await kbRes.json();
      console.log("  results count:", kbData.results?.length);
    } else {
      console.log("  error:", await kbRes.text());
    }
  }

  await db.$disconnect();
}

main().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
