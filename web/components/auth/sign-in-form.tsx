"use client";

/* eslint-disable shadcn/no-restyle -- Sign-in-only rounded/filled treatment; keep shared controls unchanged. */

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
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { REGEXP_ONLY_DIGITS } from "input-otp";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "@/lib/auth-client";
import { safeFamilyRedirect } from "@/lib/base-domain";
import { cn } from "@/lib/utils";
import styles from "./sign-in-form.module.css";

/**
 * Sign-in (specs/people.md rule 10): Google, or a 6-digit code emailed to you. No passwords or self-sign-up.
 * Accounts are created by operators or when someone is added to an org.
 */
export function SignInForm({
  redirectTo,
  googleEnabled,
  error: initialError,
}: {
  redirectTo?: string;
  googleEnabled: boolean;
  /** Why the last Google sign-in was refused (the page reads it from ?error=). */
  error?: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState("");

  async function sendCode() {
    setBusy(true);
    setError(null);
    const { error } = await authClient.emailOtp.sendVerificationOtp({ email: email.trim(), type: "sign-in" });
    setBusy(false);
    if (error) {
      if (error.code === "USER_NOT_FOUND") {
        setCodeSent(false);
        setCode("");
      }
      return setError(error.code === "INVALID_EMAIL" ? "Enter a valid email address." : error.message ?? "Could not send the code");
    }
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
      setError(codeError(error));
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
    <div
      data-sign-in
      className={cn("flex flex-col gap-10", styles.entrance)}
      onFocusCapture={(event) => {
        // Finish instead of removing the animation, so blur cannot restart it.
        event.target.closest<HTMLElement>("[data-enter]")?.getAnimations().forEach((animation) => animation.finish());
      }}
    >
      <header data-enter="heading" className="flex flex-col items-center gap-3 text-center">
        <Link href="/" aria-label="TrainerTwin home" className="mb-2 grid size-10 place-items-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <Image src="/trainertwin-mark.svg" alt="" width={28} height={28} />
        </Link>
        <h1 className="text-2xl leading-tight font-medium tracking-tight text-foreground">
          {codeSent ? "Enter your code" : "Welcome to TrainerTwin"}
        </h1>
        <FieldDescription className="text-center">
          {codeSent ? "Use your six-digit code to finish signing in." : "Sign in with the email your trainer added."}
        </FieldDescription>
      </header>

      <form data-enter="form" onSubmit={onSubmit}>
        <FieldGroup className="gap-6">
          {googleEnabled && !codeSent ? (
            <>
              <Field>
                <GoogleSignInButton className="h-11 w-full rounded-xl" />
              </Field>
              <FieldSeparator className="my-1 text-xs">or</FieldSeparator>
            </>
          ) : null}

          <Field data-invalid={Boolean(error) && !codeSent}>
            <FieldLabel htmlFor="email">Email</FieldLabel>
            <div className="rounded-xl bg-muted">
              <Input
                id="email"
                name="email"
                type="email"
                placeholder="you@example.com"
                className="h-11 rounded-xl border-transparent px-4"
                disabled={busy}
                autoComplete="email"
                aria-invalid={Boolean(error) && !codeSent}
                aria-describedby={error && !codeSent ? "sign-in-error" : undefined}
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  setCodeSent(false);
                }}
                required
              />
            </div>
          </Field>

          {codeSent ? (
            <Field data-invalid={Boolean(error)}>
              <div className="flex items-center justify-between gap-3">
                <FieldLabel htmlFor="code">Code</FieldLabel>
                <Button type="button" variant="ghost" size="sm" className="h-10 rounded-lg" disabled={busy} onClick={() => void sendCode()}>
                  Resend code
                </Button>
              </div>
              {/* One input underneath the six cells keeps paste, autofill and keyboard navigation native. */}
              <InputOTP
                id="code"
                name="code"
                minLength={6}
                maxLength={6}
                pattern={REGEXP_ONLY_DIGITS}
                autoComplete="one-time-code"
                value={code}
                onChange={setCode}
                disabled={busy}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? "code-help sign-in-error" : "code-help"}
                autoFocus
                required
              >
                <InputOTPGroup>
                  {[0, 1, 2, 3, 4, 5].map((index) => <InputOTPSlot key={index} index={index} className="h-11 rounded-xl" aria-invalid={Boolean(error)} />)}
                </InputOTPGroup>
              </InputOTP>
              <FieldDescription id="code-help">
                Code expires in 10 minutes.
              </FieldDescription>
            </Field>
          ) : null}

          {error ? (
            <p id="sign-in-error" role="alert" className="text-destructive text-sm font-medium">
              {error}
            </p>
          ) : null}

          <Field>
            <Button type="submit" variant="default" disabled={busy || (codeSent && code.length !== 6)} className="h-11 w-full rounded-xl">
              {busy ? <Spinner data-icon="inline-start" /> : null}
              {busy ? (codeSent ? "Signing in…" : "Sending…") : codeSent ? "Sign in" : "Continue"}
            </Button>
          </Field>
        </FieldGroup>
      </form>

      <FieldDescription data-enter="footer" className="mt-2 px-6 text-center text-xs leading-relaxed">
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

/** A refused code, in the person's words. An unknown email gets no code (no self sign-up), so a wrong code says both. */
function codeError(error: { code?: string; message?: string }) {
  if (error.code === "OTP_EXPIRED") return "That code has expired. Send a new code.";
  if (error.code === "TOO_MANY_ATTEMPTS") return "Too many tries with that code. Send a new code.";
  if (error.code === "INVALID_OTP" || !error.message) return "That code didn't work. Check the code, and that this is the email your trainer added.";
  return error.message; // e.g. a disabled member: "Your access has been disabled. Contact your trainer."
}
