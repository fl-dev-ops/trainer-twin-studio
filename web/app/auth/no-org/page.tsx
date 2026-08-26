import Link from "next/link";

export default function NoOrgPage() {
  return (
    <main className="flex min-h-svh items-center justify-center p-4">
      <div className="w-full max-w-sm text-center">
        <h1 className="text-lg font-semibold">No organization yet</h1>
        <p className="text-muted-foreground mt-2 text-sm">
          Your account isn&apos;t part of an organization yet. Use the invite link
          you were given, or ask your trainer to invite you.
        </p>
        <Link href="/sign-in" className="text-foreground mt-4 inline-block text-sm underline underline-offset-4">
          Sign in
        </Link>
      </div>
    </main>
  );
}
