import { z } from "zod";
import { db } from "@/lib/db";
import { API_LEARNER_ROLE, paginationFromUrl, requireExternalApi, apiRoute } from "@/lib/external-api";
import { errorResponse, refusals } from "@/lib/errors";
import { addLearnerByApi } from "@/lib/invite/org";
import { LEARNER, orgPeople, type OrgPerson } from "@/lib/org-people";

const createSchema = z.object({ email: z.string().trim().email().max(320) }).strict();

/** The documented `User` object: every listed person is a learner, which the API calls `member` (API_LEARNER_ROLE). */
const userView = (person: OrgPerson, emailVerified: boolean) => ({
  id: person.userId,
  name: person.name,
  email: person.email,
  emailVerified,
  createdAt: person.addedAt,
  role: API_LEARNER_ROLE,
  memberId: person.memberId,
});

async function handleGET(request: Request) {
  const api = await requireExternalApi(request, "users", "read");
  const page = paginationFromUrl(new URL(request.url));

  // The org's learners (lib/org-people.ts), newest first. Everyone added is a member right away, so there are no
  // pending invitations: `invitations` stays (always empty) for older integrations.
  // shortcut: pages in memory over the org's learners; add skip/take to orgPeople if an org passes a few thousand.
  const learners = (await orgPeople(api.org.id, { roles: [LEARNER] })).reverse();
  const shown = learners.slice(page.offset, page.offset + page.limit);
  const verified = await emailsVerified(shown.map((person) => person.userId));
  return Response.json({
    users: shown.map((person) => userView(person, verified.has(person.userId))),
    invitations: [],
    pagination: { ...page, total: learners.length },
  });
}

async function handlePOST(request: Request) {
  const api = await requireExternalApi(request, "users", "write");
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse(refusals.invalidInput("A valid email is required"));

  // Added to the org as a learner right away (with starting credits) and emailed; they just sign in.
  const { person, created, emailSent } = await addLearnerByApi({ org: api.org, by: { userId: api.trainer.userId, name: api.trainer.name }, email: parsed.data.email });
  const verified = await emailsVerified([person.userId]);
  return Response.json({ user: userView(person, verified.has(person.userId)), created, emailSent }, { status: created ? 201 : 200 });
}

/** Which of these accounts have confirmed their email (signed in at least once). */
async function emailsVerified(userIds: string[]) {
  const rows = userIds.length ? await db.user.findMany({ where: { id: { in: userIds }, emailVerified: true }, select: { id: true } }) : [];
  return new Set(rows.map((row) => row.id));
}

export const GET = apiRoute(handleGET);
export const POST = apiRoute(handlePOST);
