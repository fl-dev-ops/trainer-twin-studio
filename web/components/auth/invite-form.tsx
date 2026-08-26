"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { authClient } from "@/lib/auth-client";

/** Learner sign-up via trainer invitation: account details + password, then join the org. */
export function InviteForm({ invitationId, email }: { invitationId: string; email: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") ?? "");
    if (password !== form.get("confirmPassword")) {
      setError("Passwords do not match");
      setBusy(false);
      return;
    }
    const first = String(form.get("firstName") ?? "").trim();
    const last = String(form.get("lastName") ?? "").trim();

    const signUp = await authClient.signUp.email({
      name: `${first} ${last}`.trim(),
      email,
      password,
    });
    if (signUp.error) {
      setError(signUp.error.message ?? "Sign up failed");
      setBusy(false);
      return;
    }
    // Join the inviting organization. The invitation email must match.
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
        <CardTitle>Join your trainer</CardTitle>
        <CardDescription>You were invited to practice sessions.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="grid gap-5">
          <div className="grid gap-4">
            <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              Your details
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label htmlFor="firstName">First name</Label>
                <Input id="firstName" name="firstName" autoComplete="given-name" required />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="lastName">Last name</Label>
                <Input id="lastName" name="lastName" autoComplete="family-name" required />
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" value={email} readOnly />
              <p className="text-muted-foreground text-xs">
                The address your trainer invited.
              </p>
            </div>
          </div>

          <Separator />

          <div className="grid gap-4">
            <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              Password
            </p>
            <div className="grid gap-2">
              <Label htmlFor="password">Password</Label>
              <Input id="password" name="password" type="password" minLength={8} autoComplete="new-password" required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="confirmPassword">Confirm password</Label>
              <Input id="confirmPassword" name="confirmPassword" type="password" minLength={8} autoComplete="new-password" required />
            </div>
          </div>

          {error ? (
            <p role="alert" className="text-destructive text-sm">{error}</p>
          ) : null}
          <Button type="submit" disabled={busy}>
            {busy ? "Joining…" : "Join"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
