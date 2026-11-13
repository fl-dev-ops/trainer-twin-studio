import { apiRoute, requireExternalApi } from "@/lib/external-api";
import { DEFAULT_LEARNER_MINUTES, MAX_LEARNER_MINUTES } from "@/lib/minutes-config";
import { orgCredits } from "@/lib/org-credits";

async function handleGET(request: Request) {
  const api = await requireExternalApi(request, "users", "read");
  const credits = await orgCredits(api.org.id, { fresh: true });
  return Response.json({
    balanceMinutes: Math.max(0, credits.seconds) / 60,
    defaultLearnerMinutes: DEFAULT_LEARNER_MINUTES,
    maxLearnerMinutes: MAX_LEARNER_MINUTES,
  });
}

export const GET = apiRoute(handleGET);
