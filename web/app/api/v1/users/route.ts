import { z } from "zod";
import { db } from "@/lib/db";
import { API_LEARNER_ROLE, isApiError, paginationFromUrl, requireExternalApi } from "@/lib/external-api";
import { AppError, errorResponse, refusals } from "@/lib/errors";
import { addLearnerByApi } from "@/lib/invite/org";
import { MinutesError } from "@/lib/minutes";
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

export async function GET(request: Request) {
  const api = await requireExternalApi(request, "users", "read");
  if (isApiError(api)) return api;
  const page = paginationFromUrl(new URL(request.url));
  if (page instanceof Response) return page;

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

export async function POST(request: Request) {
  const api = await requireExternalApi(request, "users", "write");
  if (isApiError(api)) return api;
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse(refusals.invalidInput("A valid email is required"));

  try {
    // Added to the org as a learner right away (with starting credits) and emailed; they just sign in.
    const { person, created, emailSent } = await addLearnerByApi({ org: api.org, by: { userId: api.trainer.userId, name: api.trainer.name }, email: parsed.data.email });
    const verified = await emailsVerified([person.userId]);
    return Response.json({ user: userView(person, verified.has(person.userId)), created, emailSent }, { status: created ? 201 : 200 });
  } catch (error) {
    if (error instanceof AppError) return errorResponse(error);
    if (error instanceof MinutesError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}

/** Which of these accounts have confirmed their email (signed in at least once). */
async function emailsVerified(userIds: string[]) {
  const rows = userIds.length ? await db.user.findMany({ where: { id: { in: userIds }, emailVerified: true }, select: { id: true } }) : [];
  return new Set(rows.map((row) => row.id));
}
