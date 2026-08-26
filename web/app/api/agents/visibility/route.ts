import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionOrg } from "@/lib/org";
import { db } from "@/lib/db";

const bodySchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i),
  visibility: z.enum(["public", "private"]),
});

/** Toggle an agent between public (listed on the org's learner portal) and private. */
export async function POST(request: Request) {
  const org = await getSessionOrg();
  if (!org) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const updated = await db.agent.updateMany({
    where: { slug: parsed.data.slug, orgId: org.id },
    data: { visibility: parsed.data.visibility },
  });
  if (updated.count === 0) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  return NextResponse.json({ ok: true, visibility: parsed.data.visibility });
}
