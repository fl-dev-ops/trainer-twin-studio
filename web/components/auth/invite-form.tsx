"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { GoogleSignInButton } from "@/components/auth/google-sign-in-button";
import { SwitchAccountButton } from "@/components/auth/switch-account-button";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { authClient } from "@/lib/auth-client";

/** A studio invite (admin, team): Google sign-in with the invited email (back to this page), then join the org. */
export function InviteForm({ invitationId, email, organizationName, signedInEmail }: {
  invitationId: string;
  email: string;
  organizationName: string;
  signedInEmail?: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function acceptInvitation() {
    setBusy(true);
    setError(null);
    // Better Auth verifies the signed-in user's email against the invitation.
    const accepted = await authClient.organization.acceptInvitation({ invitationId });
    if (accepted.error) {
      setError(accepted.error.message ?? "Could not accept the invitation");
      setBusy(false);
      return;
    }
    const res = await fetch("/api/me/home", { cache: "no-store" });
    const { redirect } = await res.json();
    router.push(redirect);
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Join {organizationName}</CardTitle>
        <CardDescription>You were invited to the {organizationName} studio on TrainerTwin.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {signedInEmail ? (
          signedInEmail.toLowerCase() === email.toLowerCase() ? (
            <Button type="button" disabled={busy} onClick={acceptInvitation} className="w-full">
              {busy ? "Joining…" : "Accept invitation"}
            </Button>
          ) : (
            <div className="grid gap-3">
              <p className="text-muted-foreground text-sm">
                This invitation is for {email}. Sign out of {signedInEmail} and use the invited email.
              </p>
              <SwitchAccountButton returnTo={`/invite?token=${encodeURIComponent(invitationId)}`} />
            </div>
          )
        ) : (
          <div className="grid gap-3">
            <p className="text-muted-foreground text-sm">Continue with the Google account for {email}.</p>
            <GoogleSignInButton className="w-full" />
          </div>
        )}
        {error ? <p role="alert" className="text-destructive text-sm">{error}</p> : null}
      </CardContent>
    </Card>
  );
}
