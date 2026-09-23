import Link from "next/link";

export default function NoOrgPage() {
  return (
    <main className="flex min-h-svh items-center justify-center p-4">
      <div className="w-full max-w-sm text-center">
        <h1 className="text-lg font-semibold">No practice session selected</h1>
        <p className="text-muted-foreground mt-2 text-sm">
          Open the practice link your trainer sent you to start a session.
        </p>
        <Link href="/sign-in" className="text-foreground mt-4 inline-block text-sm underline underline-offset-4">
          Sign in
        </Link>
      </div>
    </main>
  );
}
