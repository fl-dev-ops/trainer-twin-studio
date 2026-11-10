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

/**
 * Sign-in (specs/people.md rule 10): Google, or a 6-digit code emailed to you. No passwords. The first sign-in with an
 * email creates the account; someone added to an org already has one and lands in it.
 */
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
  const [email, setEmail] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState("");

  async function sendCode() {
    setBusy(true);
    setError(null);
    const { error } = await authClient.emailOtp.sendVerificationOtp({ email: email.trim(), type: "sign-in" });
    setBusy(false);
    if (error) return setError(error.message ?? "Could not send the code");
    setCodeSent(true);
    setCode("");
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!codeSent) return sendCode();
    setBusy(true);
    setError(null);
    const { error } = await authClient.signIn.emailOtp({ email: email.trim(), otp: code.trim() });
    if (error) {
      setError(error.message ?? "That code didn't work");
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
              Sign in with Google, or with a code we email you.
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

          <Field data-invalid={Boolean(error) && !codeSent}>
            <FieldLabel htmlFor="email">Email</FieldLabel>
            <Input
              id="email"
              name="email"
              type="email"
              placeholder="m@example.com"
              autoComplete="email"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                setCodeSent(false);
              }}
              required
            />
          </Field>

          {codeSent ? (
            <Field data-invalid={Boolean(error)}>
              <FieldLabel htmlFor="code">Code</FieldLabel>
              <Input
                id="code"
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                placeholder="6-digit code"
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
                autoFocus
                required
              />
              <FieldDescription>
                We sent a code to {email.trim()}. It works for 10 minutes.{" "}
                <button type="button" className="text-foreground underline underline-offset-4" disabled={busy} onClick={() => void sendCode()}>
                  Send a new code
                </button>
              </FieldDescription>
            </Field>
          ) : null}

          {error ? (
            <p role="alert" className="text-destructive text-sm font-medium">
              {error}
            </p>
          ) : null}

          <Field>
            <Button type="submit" disabled={busy} className="w-full">
              {busy ? <Spinner data-icon="inline-start" /> : null}
              {busy ? (codeSent ? "Signing in…" : "Sending…") : codeSent ? "Sign in" : "Email me a code"}
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
