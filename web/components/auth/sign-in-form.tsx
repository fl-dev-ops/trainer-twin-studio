"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import Image from "next/image";
import { GoogleSignInButton } from "@/components/auth/google-sign-in-button";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "@/lib/auth-client";
import { safeFamilyRedirect } from "@/lib/base-domain";

export function SignInForm({
  redirectTo,
  googleEnabled,
}: {
  redirectTo?: string;
  googleEnabled: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const { error } = await authClient.signIn.email({
      email: String(form.get("email") ?? "").trim(),
      password: String(form.get("password") ?? ""),
    });
    if (error) {
      setError(error.message ?? "Sign in failed");
      setBusy(false);
      return;
    }
    const requested = safeFamilyRedirect(redirectTo);
    if (requested) {
      window.location.assign(requested);
      return;
    }
    const res = await fetch("/api/me/home", { cache: "no-store" });
    const { redirect } = await res.json();
    router.push(redirect);
  }

  return (
    <div className="flex flex-col gap-6">
      <form onSubmit={onSubmit}>
        <FieldGroup>
          <div className="flex flex-col items-center gap-2 text-center">
            <Link
              href="/"
              className="flex flex-col items-center gap-2 font-medium"
            >
              <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary shadow-xs">
                <Image
                  src="/trainertwin-mark.svg"
                  alt="TrainerTwin"
                  width={24}
                  height={24}
                  className="size-6"
                />
              </div>
              <span className="sr-only">TrainerTwin</span>
            </Link>
            <h1 className="text-xl font-bold tracking-tight text-foreground">
              Welcome to TrainerTwin
            </h1>
            <FieldDescription>
              Don&apos;t have an account?{" "}
              <Link
                href={
                  redirectTo
                    ? `/sign-up?redirect=${encodeURIComponent(redirectTo)}`
                    : "/sign-up"
                }
                className="text-foreground underline underline-offset-4"
              >
                Sign up
              </Link>
            </FieldDescription>
          </div>

          {googleEnabled ? (
            <>
              <Field>
                <GoogleSignInButton />
              </Field>
              <FieldSeparator>Or continue with email</FieldSeparator>
            </>
          ) : null}

          <Field data-invalid={Boolean(error)}>
            <FieldLabel htmlFor="email">Email</FieldLabel>
            <Input
              id="email"
              name="email"
              type="email"
              placeholder="m@example.com"
              autoComplete="email"
              required
            />
          </Field>

          <Field data-invalid={Boolean(error)}>
            <FieldLabel htmlFor="password">Password</FieldLabel>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </Field>

          {error ? (
            <p role="alert" className="text-destructive text-sm font-medium">
              {error}
            </p>
          ) : null}

          <Field>
            <Button type="submit" disabled={busy} className="w-full">
              {busy ? <Spinner data-icon="inline-start" /> : null}
              {busy ? "Signing in…" : "Sign in"}
            </Button>
          </Field>
        </FieldGroup>
      </form>

      <FieldDescription className="px-6 text-center text-xs">
        By continuing, you agree to our{" "}
        <a
          href="https://www.trainertwin.com/privacy"
          target="_blank"
          rel="noopener noreferrer"
          className="text-foreground underline underline-offset-4"
        >
          Privacy Policy
        </a>
        .
      </FieldDescription>
    </div>
  );
}
