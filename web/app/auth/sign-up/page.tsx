import { redirect } from "next/navigation";

/** There is no separate sign-up: the first sign-in (Google or an email code) creates the account. */
export default async function SignUpPage({ searchParams }: { searchParams: Promise<{ redirect?: string }> }) {
  const { redirect: next } = await searchParams;
  redirect(next ? `/sign-in?redirect=${encodeURIComponent(next)}` : "/sign-in");
}
