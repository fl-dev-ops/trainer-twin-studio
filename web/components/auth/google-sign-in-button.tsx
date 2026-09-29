"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

export function GoogleSignInButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setBusy(true);
    setError(null);
    try {
      const result = await authClient.signIn.social({
        provider: "google",
        // Return to this page so its existing redirect/invitation logic can finish.
        callbackURL: window.location.href,
      });
      if (result.error) setError(result.error.message ?? "Google sign-in failed. Try again.");
    } catch {
      setError("Google sign-in failed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-3">
      <Button type="button" variant="outline" onClick={signIn} disabled={busy} className="w-full">
        {busy ? "Connecting to Google…" : "Continue with Google"}
      </Button>
      {error ? <p role="alert" className="text-destructive text-sm">{error}</p> : null}
      <p className="text-center text-xs text-muted-foreground">or continue with email</p>
    </div>
  );
}
