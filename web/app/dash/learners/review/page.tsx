import { redirect } from "next/navigation";

/**
 * A learner's sessions are the Sessions page filtered to them; each session page carries the
 * recording and AI evaluation. Kept so existing /learners/review links still land somewhere.
 */
export default async function LearnerReviewPage({ searchParams }: { searchParams: Promise<{ learner?: string }> }) {
  const { learner } = await searchParams;
  redirect(learner ? `/sessions?learner=${encodeURIComponent(learner)}&range=all` : "/learners");
}
