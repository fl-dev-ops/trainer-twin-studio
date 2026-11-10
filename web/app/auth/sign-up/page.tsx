import { redirect } from "next/navigation";

/** There is no self-sign-up: operators or org admins must add the account before sign-in. */
export default async function SignUpPage({ searchParams }: { searchParams: Promise<{ redirect?: string }> }) {
  const { redirect: next } = await searchParams;
  redirect(next ? `/sign-in?redirect=${encodeURIComponent(next)}` : "/sign-in");
}
