/**
 * Prefetches eligible resume claims for the next main question so the model can go straight to
 * start_resume_question. Each list/get round trip it replaces cost a full LLM call (~2.5 s);
 * these studio reads are plain HTTP (~0.3 s) and run inside the session_plan tool call.
 */
export const RESUME_CANDIDATE_LIMIT = 3;
const CANDIDATE_TEXT_CHARS = 1_500;

export type ResumeClaimCandidate = {
  claimId: string;
  section?: string;
  kind?: string;
  text: string;
  metric?: unknown;
};

type ListedClaim = { claimId: string };
type Fetch = <T>(payload: Record<string, unknown>) => Promise<T>;

export async function resumeClaimCandidates(sessionId: string, fetch: Fetch): Promise<ResumeClaimCandidate[]> {
  const listed = await fetch<{ claims?: ListedClaim[] }>({ action: "listResumeClaims", sessionId });
  const ids = (listed.claims ?? []).slice(0, RESUME_CANDIDATE_LIMIT).map((claim) => claim.claimId);
  const claims = await Promise.all(ids.map((claimId) =>
    fetch<ResumeClaimCandidate>({ action: "getResumeClaim", sessionId, claimId }).catch(() => null)));
  return claims
    .filter((claim): claim is ResumeClaimCandidate => Boolean(claim?.claimId && claim.text))
    .map((claim) => ({ ...claim, text: claim.text.slice(0, CANDIDATE_TEXT_CHARS) }));
}
