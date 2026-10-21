import assert from "node:assert/strict";
import test from "node:test";
import { RESUME_CANDIDATE_LIMIT, resumeClaimCandidates } from "../../../agent/lib/resume-candidates";

test("resumeClaimCandidates returns the first eligible claims with text, skipping claims that fail to load", async () => {
  const calls: Record<string, unknown>[] = [];
  const fetch = async <T,>(payload: Record<string, unknown>): Promise<T> => {
    calls.push(payload);
    if (payload.action === "listResumeClaims") {
      return { claims: [{ claimId: "c1" }, { claimId: "c2" }, { claimId: "c3" }, { claimId: "c4" }] } as T;
    }
    if (payload.claimId === "c2") throw new Error("Eligible resume claim not found");
    return { claimId: payload.claimId, section: "Experience", text: `${payload.claimId} ${"x".repeat(2_000)}` } as T;
  };

  const candidates = await resumeClaimCandidates("session-1", fetch);

  assert.deepEqual(candidates.map((claim) => claim.claimId), ["c1", "c3"]);
  assert.equal(candidates[0].text.length, 1_500);
  assert.equal(calls.filter((call) => call.action === "getResumeClaim").length, RESUME_CANDIDATE_LIMIT);
  assert.ok(calls.every((call) => call.sessionId === "session-1"));
});

test("resumeClaimCandidates returns nothing when no claims are eligible", async () => {
  const fetch = async <T,>(): Promise<T> => ({ claims: [] }) as T;
  assert.deepEqual(await resumeClaimCandidates("session-1", fetch), []);
});
