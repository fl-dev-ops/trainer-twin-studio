import { z } from "zod";
import { BASE_DOMAIN } from "@/lib/base-domain";
import { getTrainerOrg } from "@/lib/org";
import { createTwinShareLink, findTwinAgent, listTwinShareLinks, setTwinShareLinkStatus, TwinAccessError } from "@/lib/twin-access";

export const runtime = "nodejs";

const createSchema = z.object({ minutesPerUser: z.number().int().min(1).max(10_000) }).strict();
const updateSchema = z.object({ linkId: z.string().min(1), status: z.enum(["active", "disabled"]) }).strict();

const failed = (error: unknown) => {
  if (error instanceof TwinAccessError) return Response.json({ error: error.message }, { status: error.status });
  throw error;
};

/** The twin's common links; each person who opens one gets their own minutes. Studio only (admin, team). */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const trainer = await getTrainerOrg();
  if (!trainer) return Response.json({ error: "Forbidden" }, { status: 403 });
  try {
    const agent = await findTwinAgent(trainer.id, (await params).slug);
    const links = await listTwinShareLinks(trainer.id, agent.id);
    return Response.json({
      links: links.map(({ code, _count, ...link }) => ({ ...link, joined: _count.assignments, url: `https://${trainer.slug}.${BASE_DOMAIN}/s/${code}` })),
    });
  } catch (error) {
    return failed(error);
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const trainer = await getTrainerOrg();
  if (!trainer) return Response.json({ error: "Forbidden" }, { status: 403 });
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Give the minutes each person gets" }, { status: 400 });
  try {
    const agent = await findTwinAgent(trainer.id, (await params).slug);
    const { code, ...link } = await createTwinShareLink({
      orgId: trainer.id, agentId: agent.id, minutesPerUser: parsed.data.minutesPerUser, createdByUserId: trainer.user.id,
    });
    return Response.json({ link: { ...link, url: `https://${trainer.slug}.${BASE_DOMAIN}/s/${code}` } }, { status: 201 });
  } catch (error) {
    return failed(error);
  }
}

/** Disables (or re-enables) a link; people who already joined keep their own assignment. */
export async function PATCH(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const trainer = await getTrainerOrg();
  if (!trainer) return Response.json({ error: "Forbidden" }, { status: 403 });
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Give a linkId and a status" }, { status: 400 });
  try {
    const agent = await findTwinAgent(trainer.id, (await params).slug);
    return Response.json({ link: await setTwinShareLinkStatus({ orgId: trainer.id, agentId: agent.id, ...parsed.data }) });
  } catch (error) {
    return failed(error);
  }
}
