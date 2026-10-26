import { z } from "zod";
import { getTrainerOrg } from "@/lib/org";
import { ensureTwin, TwinError } from "@/lib/twins";

export const runtime = "nodejs";

const body = z.object({ personaSlug: z.string().trim().min(1).max(100) });

/** Creates the persona's twin ("Ask Olga"): an open conversation over all of the persona's playbooks. */
export async function POST(request: Request) {
  const org = await getTrainerOrg();
  if (!org) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "personaSlug is required" }, { status: 400 });
  try {
    const twin = await ensureTwin(org.id, parsed.data.personaSlug);
    return Response.json(twin, { status: twin.created ? 201 : 200 });
  } catch (error) {
    if (error instanceof TwinError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
}
