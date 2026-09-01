"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
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
import { BASE_DOMAIN } from "@/lib/base-domain";
import { apiUrl } from "@/lib/api-url";

function SectionLabel({ children }: { children: string }) {
  return (
    <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
      {children}
    </p>
  );
}

export function FounderForm({ token, email }: { token: string; email: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [slug, setSlug] = useState("");
  const [slugState, setSlugState] = useState<{ available: boolean; reason: string | null } | null>(null);

  // Live slug availability (debounced).
  useEffect(() => {
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug) || slug.length < 3) {
      setSlugState(null);
      return;
    }
    const timer = setTimeout(async () => {
      const res = await fetch(apiUrl(`/api/onboarding?slug=${encodeURIComponent(slug)}`), { cache: "no-store" });
      setSlugState(await res.json());
    }, 300);
    return () => clearTimeout(timer);
  }, [slug]);

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

    const res = await fetch(apiUrl("/api/onboarding"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, orgName: String(form.get("orgName") ?? "").trim(), slug }),
    });
    const body = await res.json();
    if (!res.ok) {
      setError(body.error ?? "Could not create your workspace");
      setBusy(false);
      return;
    }
    router.push(body.redirect);
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Set up your workspace</CardTitle>
        <CardDescription>You were invited to create an organization.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="grid gap-5">
          <div className="grid gap-4">
            <SectionLabel>Your details</SectionLabel>
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
                The address your invite was sent to.
              </p>
            </div>
          </div>

          <Separator />

          <div className="grid gap-4">
            <SectionLabel>Your organization</SectionLabel>
            <div className="grid gap-2">
              <Label htmlFor="orgName">Organization name</Label>
              <Input id="orgName" name="orgName" placeholder="Career with Vasanth" required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="slug">Subdomain</Label>
              <div className="flex items-center gap-1">
                <Input
                  id="slug"
                  value={slug}
                  onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                  minLength={3}
                  maxLength={30}
                  pattern="[a-z0-9][a-z0-9-]*[a-z0-9]"
                  required
                />
                <span className="text-muted-foreground whitespace-nowrap text-sm">.{BASE_DOMAIN}</span>
              </div>
              {slug.length >= 3 && slugState ? (
                <p className={slugState.available ? "text-sm text-green-600" : "text-destructive text-sm"}>
                  {slugState.available ? `${slug} is available` : slugState.reason}
                </p>
              ) : (
                <p className="text-muted-foreground text-xs">
                  Your learners will visit https://{slug || "<name>"}.…
                </p>
              )}
            </div>
          </div>

          <Separator />

          <div className="grid gap-4">
            <SectionLabel>Password</SectionLabel>
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
            {busy ? "Creating…" : "Create workspace"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
