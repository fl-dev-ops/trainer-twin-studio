"use client";

import { useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Eye,
  EyeOff,
  Loader2,
} from "lucide-react";
import { OnboardingProgress } from "@/components/auth/onboarding-stepper";
import { authClient } from "@/lib/auth-client";
import { BASE_DOMAIN } from "@/lib/base-domain";

function inferCompanyFromEmail(email: string) {
  if (!email || !email.includes("@")) return { name: "", slug: "" };
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  const root = domain.split(".")[0] ?? "";
  const generic = new Set([
    "gmail",
    "googlemail",
    "yahoo",
    "hotmail",
    "outlook",
    "live",
    "icloud",
    "me",
    "proton",
    "protonmail",
    "aol",
    "zoho",
    "mail",
  ]);
  if (!root || generic.has(root) || root.length < 2) {
    return { name: "", slug: "" };
  }
  const name = root.charAt(0).toUpperCase() + root.slice(1);
  const cleanSlug = root.replace(/[^a-z0-9-]/g, "").slice(0, 30);
  return { name, slug: cleanSlug };
}

/* -------------------------------------------------------------------------- */
/*                                Brand Logos                                 */
/* -------------------------------------------------------------------------- */

function NotionLogo({ className = "size-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M4.459 4.208c.746.606 1.034.672 2.42.672h11.92c.26 0 .192-.032.434-.128.042-.032 0-.064-.13-.16l-1.47-1.184c-.52-.4-.86-.672-1.86-.672H6.536c-.78 0-.52.192.13.672l-2.207 1.8zm.78 2.016v12.704c0 .736.26 1.024 1.034 1.056l12.506.384c.78.032 1.034-.288 1.034-1.024V6.224c0-.736-.26-.992-.86-.96l-12.64.32c-.65.032-.994.288-.994.96zm11.726.8c.13.608 0 1.216-.608 1.28l-.52.064v9.152c-.434.224-.78.352-1.086.352-.52 0-.65-.16-1.034-.608l-3.172-4.992v4.832l1.002.224s0 1.216-1.69 1.216l-4.64-.288c-.13-.032-.26-.16-.26-.352.032-.224.26-.48.26-.48l1.212-.288V9.2l-1.69-.064C4.85 9.04 4.85 8.24 5.5 8.08l4.38-.288c.564 0 .65.16 1.086.608l3.042 4.8V8.8l-.78-.064c-.608-.064-.736-.672-.608-1.28l3.952.256.482.32z" />
    </svg>
  );
}

function YouTubeLogo({ className = "size-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path
        d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"
        className="fill-[#FF0000]"
      />
    </svg>
  );
}

/* -------------------------------------------------------------------------- */
/*                               Main Component                               */
/* -------------------------------------------------------------------------- */

export function FounderForm({
  token,
  email,
  connectors,
  initialStep = 1,
  initialConnections = { notion: false, youtube: false },
  defaultOrgName = "",
  defaultSlug = "",
  oauthNotice,
}: {
  token: string;
  email: string;
  connectors: { notion: boolean; youtube: boolean };
  initialStep?: 1 | 2 | 3;
  initialConnections?: { notion: boolean; youtube: boolean };
  defaultOrgName?: string;
  defaultSlug?: string;
  oauthNotice?: {
    connector?: string;
    connected?: boolean;
    error?: string;
  };
}) {
  const [step, setStep] = useState<1 | 2 | 3>(initialStep);
  const [error, setError] = useState<string | null>(null);

  // Form Fields
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  const initialCompany = inferCompanyFromEmail(email);
  const [orgName, setOrgName] = useState(defaultOrgName || initialCompany.name);
  const [slug, setSlug] = useState(defaultSlug || initialCompany.slug);
  const [slugState, setSlugState] = useState<{
    available: boolean;
    reason: string | null;
  } | null>(null);
  const [checkingSlug, setCheckingSlug] = useState(false);

  // Connectors State
  const [connections] = useState(initialConnections);
  const [connecting, setConnecting] = useState<"notion" | "youtube" | null>(
    null,
  );

  // Provisioning Lifecycle
  const [stage, setStage] = useState<"idle" | "account" | "workspace" | "done">(
    "idle",
  );
  const [accountCreated, setAccountCreated] = useState(initialStep === 3);

  // Auto-generate initial slug suggestion from orgName
  const [slugTouched, setSlugTouched] = useState(
    Boolean(defaultSlug || initialCompany.slug),
  );
  const handleOrgNameChange = (val: string) => {
    setOrgName(val);
    if (!slugTouched) {
      const generated = val
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 30);
      setSlug(generated);
      setSlugState(null);
    }
  };

  // Live Slug Availability Check
  useEffect(() => {
    const isValid =
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug) && slug.length >= 3;
    if (!isValid) return;

    const timer = setTimeout(async () => {
      setCheckingSlug(true);
      try {
        const res = await fetch(
          `/api/onboarding?slug=${encodeURIComponent(slug)}`,
          {
            cache: "no-store",
          },
        );
        const data = await res.json();
        setSlugState(data);
      } finally {
        setCheckingSlug(false);
      }
    }, 280);
    return () => clearTimeout(timer);
  }, [slug]);

  // Step 1 Validation
  function handleStep1Next() {
    setError(null);
    if (!firstName.trim()) {
      setError("Please enter your first name");
      return;
    }
    if (!lastName.trim()) {
      setError("Please enter your last name");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters long");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    setStep(2);
  }

  // Step 2 Validation & Workspace Provisioning
  async function handleStep2Next() {
    setError(null);
    if (!orgName.trim()) {
      setError("Please enter your company name");
      return;
    }
    if (!slug || slug.length < 3) {
      setError("Domain must be at least 3 characters");
      return;
    }
    if (slugState && !slugState.available) {
      setError(slugState.reason ?? "That domain is taken");
      return;
    }

    // Provision account and workspace before entering Step 3 so OAuth can bind to orgId & userId
    if (!accountCreated) {
      setStage("account");
      try {
        const signUp = await authClient.signUp.email({
          name: `${firstName} ${lastName}`.trim(),
          email,
          password,
        });
        if (signUp.error) {
          throw new Error(signUp.error.message ?? "Sign up failed");
        }
        setAccountCreated(true);

        setStage("workspace");
        const res = await fetch("/api/onboarding", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token,
            orgName: orgName.trim(),
            slug,
            knowledgeConnector: "none",
          }),
        });

        const body = await res.json();
        if (!res.ok) {
          throw new Error(body.error ?? "Could not provision workspace");
        }

        setStage("idle");
        setStep(3);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Could not create workspace",
        );
        setStage("idle");
        return;
      }
    } else {
      setStep(3);
    }
  }

  // Step 3 Connector Trigger
  async function handleConnect(type: "notion" | "youtube") {
    setError(null);
    setConnecting(type);
    try {
      const res = await fetch(`/api/connectors/${type}/oauth/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "onboarding" }),
      });
      const data = await res.json();
      if (!res.ok || !data.url) {
        throw new Error(data.error ?? `Failed to start ${type} authorization`);
      }
      window.location.assign(data.url);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : `Failed to connect ${type}`,
      );
      setConnecting(null);
    }
  }

  // Navigate to Studio Dashboard
  function handleGoToDashboard() {
    const port = window.location.port ? `:${window.location.port}` : "";
    window.location.assign(`https://dash.${BASE_DOMAIN}${port}/`);
  }

  const isBusy = stage !== "idle";
  const hasAnyConnection = connections.notion || connections.youtube;

  return (
    <div className="w-full max-w-xl mx-auto min-h-[380px]">
      {/* -------------------------------------------------------------------- */}
      {/* Staged Thin-Pill Progress Bar (Above Form Title)                    */}
      {/* -------------------------------------------------------------------- */}
      <OnboardingProgress
        currentStep={step}
        onStepClick={(targetStep) => {
          if (!isBusy && targetStep < step) setStep(targetStep);
        }}
      />

      {/* -------------------------------------------------------------------- */}
      {/* Form Content                                                         */}
      {/* -------------------------------------------------------------------- */}
      <div>
        {/* Step 1: Personal Info / Admin Account */}
        {step === 1 && (
          <div className="space-y-6 animate-fade-in font-sans">
            <div>
              <h1 className="text-3xl font-semibold tracking-tight text-foreground">
                Create your admin credentials
              </h1>
              <p className="mt-1.5 text-sm text-muted-foreground">
                Enter your details to manage the TrainerTwin workspace.
              </p>
            </div>

            <div className="space-y-4 pt-1">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1.5">
                    First name
                  </label>
                  <input
                    type="text"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    placeholder="Sarah"
                    autoComplete="given-name"
                    className="w-full h-10 px-3.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-sm text-foreground shadow-2xs focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary placeholder:text-muted-foreground"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1.5">
                    Last name
                  </label>
                  <input
                    type="text"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    placeholder="Connor"
                    autoComplete="family-name"
                    className="w-full h-10 px-3.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-sm text-foreground shadow-2xs focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary placeholder:text-muted-foreground"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-foreground mb-1.5">
                  Email address
                </label>
                <div className="relative">
                  <input
                    type="email"
                    value={email}
                    readOnly
                    className="w-full h-10 pl-3.5 pr-28 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/60 text-sm text-muted-foreground shadow-2xs cursor-not-allowed focus:outline-none select-all"
                  />
                  <span className="absolute right-2.5 top-1/2 -translate-y-1/2 inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 px-2 py-0.5 rounded-md border border-emerald-100 dark:border-emerald-800/40 select-none">
                    <Check className="size-3" /> Verified invite
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1.5">
                    Password
                  </label>
                  <div className="relative">
                    <input
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      minLength={8}
                      autoComplete="new-password"
                      placeholder="••••••••"
                      className="w-full h-10 pl-3.5 pr-10 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-sm text-foreground shadow-2xs focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary placeholder:text-muted-foreground"
                    />
                    <button
                      type="button"
                      tabIndex={-1}
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground transition-colors"
                      aria-label={
                        showPassword ? "Hide password" : "Show password"
                      }
                    >
                      {showPassword ? (
                        <EyeOff className="size-4" />
                      ) : (
                        <Eye className="size-4" />
                      )}
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-foreground mb-1.5">
                    Confirm password
                  </label>
                  <div className="relative">
                    <input
                      type={showConfirmPassword ? "text" : "password"}
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      minLength={8}
                      autoComplete="new-password"
                      placeholder="••••••••"
                      className="w-full h-10 pl-3.5 pr-10 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-sm text-foreground shadow-2xs focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary placeholder:text-muted-foreground"
                    />
                    <button
                      type="button"
                      tabIndex={-1}
                      onClick={() =>
                        setShowConfirmPassword(!showConfirmPassword)
                      }
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground transition-colors"
                      aria-label={
                        showConfirmPassword ? "Hide password" : "Show password"
                      }
                    >
                      {showConfirmPassword ? (
                        <EyeOff className="size-4" />
                      ) : (
                        <Eye className="size-4" />
                      )}
                    </button>
                  </div>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Must be at least 8 characters.
              </p>
            </div>

            {error && (
              <p
                role="alert"
                className="text-xs font-medium text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-100 dark:border-rose-900/50 rounded-lg p-3"
              >
                {error}
              </p>
            )}

            <div className="flex items-center justify-between pt-2">
              <span />
              <button
                type="button"
                onClick={handleStep1Next}
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-6 py-2.5 text-sm font-medium text-primary-foreground shadow-sm hover:bg-primary/90 transition-all active:scale-[0.99]"
              >
                Continue <ArrowRight className="size-4" />
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Workspace Details */}
        {step === 2 && (
          <div className="space-y-6 animate-fade-in font-sans">
            <div>
              <h1 className="text-3xl font-semibold tracking-tight text-foreground">
                Name your workspace & domain
              </h1>
              <p className="mt-1.5 text-sm text-muted-foreground">
                Define your company workspace and public training portal.
              </p>
            </div>

            <div className="space-y-4 pt-1">
              <div>
                <label className="block text-sm font-medium text-foreground mb-1.5">
                  Company name
                </label>
                <input
                  type="text"
                  value={orgName}
                  disabled={isBusy}
                  onChange={(e) => handleOrgNameChange(e.target.value)}
                  placeholder="Acme Corp"
                  className="w-full h-10 px-3.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-sm text-foreground shadow-2xs focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary placeholder:text-muted-foreground disabled:opacity-60"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-foreground mb-1.5">
                  Domain
                </label>
                <div className="flex items-center rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 pr-3 focus-within:border-primary focus-within:ring-1 focus-within:ring-primary shadow-2xs">
                  <input
                    type="text"
                    value={slug}
                    disabled={isBusy}
                    onChange={(e) => {
                      setSlugTouched(true);
                      setSlug(
                        e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""),
                      );
                      setSlugState(null);
                    }}
                    placeholder="acme"
                    maxLength={30}
                    className="w-full h-10 px-3.5 border-0 bg-transparent text-sm text-foreground focus:outline-none placeholder:text-muted-foreground disabled:opacity-60"
                  />
                  <span className="text-sm text-muted-foreground select-none shrink-0">
                    .{BASE_DOMAIN}
                  </span>
                </div>

                <div className="mt-1.5 min-h-[18px]">
                  {checkingSlug ? (
                    <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                      <Loader2 className="size-3 animate-spin" /> Checking
                      availability...
                    </p>
                  ) : slug.length >= 3 && slugState ? (
                    slugState.available ? (
                      <p className="text-xs text-primary flex items-center gap-1 font-medium">
                        <Check className="size-3.5" /> https://{slug}.
                        {BASE_DOMAIN} is available
                      </p>
                    ) : (
                      <p className="text-xs text-rose-600 dark:text-rose-400 font-medium">
                        {slugState.reason ?? "That domain is taken"}
                      </p>
                    )
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Learners will visit https://{slug || "your-company"}.
                      {BASE_DOMAIN}
                    </p>
                  )}
                </div>
              </div>
            </div>

            {error && (
              <p
                role="alert"
                className="text-xs font-medium text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-100 dark:border-rose-900/50 rounded-lg p-3"
              >
                {error}
              </p>
            )}

            <div className="flex items-center justify-between pt-2">
              <button
                type="button"
                disabled={isBusy}
                onClick={() => {
                  setError(null);
                  setStep(1);
                }}
                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors disabled:opacity-50"
              >
                <ArrowLeft className="size-4" /> Back
              </button>
              <button
                type="button"
                onClick={handleStep2Next}
                disabled={
                  isBusy ||
                  !orgName.trim() ||
                  !slug ||
                  (slugState !== null && !slugState.available)
                }
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-6 py-2.5 text-sm font-medium text-primary-foreground shadow-sm hover:bg-primary/90 transition-all active:scale-[0.99] disabled:opacity-50"
              >
                {isBusy ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    <span>Creating workspace…</span>
                  </>
                ) : (
                  <>
                    Continue <ArrowRight className="size-4" />
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {/* Step 3: Knowledge Base (Action Rows, No Radio Buttons) */}
        {step === 3 && (
          <div className="space-y-6 animate-fade-in font-sans">
            <div>
              <h1 className="text-3xl font-semibold tracking-tight text-foreground">
                Connect your knowledge base
              </h1>
              <p className="mt-1.5 text-sm text-muted-foreground">
                Ground your trainer twin with content from your company
                workspace.
              </p>
            </div>

            {/* OAuth Status Notices */}
            {oauthNotice?.connected && (
              <div className="rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 p-3.5 text-xs font-medium text-emerald-800 dark:text-emerald-300 flex items-center gap-2">
                <Check className="size-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                Successfully connected{" "}
                {oauthNotice.connector === "notion" ? "Notion" : "YouTube"} to
                your workspace!
              </div>
            )}

            {oauthNotice?.error && (
              <div className="rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 p-3.5 text-xs font-medium text-amber-800 dark:text-amber-300">
                Connection was cancelled or could not be completed (
                {oauthNotice.error}). You can try again or proceed to the
                dashboard.
              </div>
            )}

            <div className="space-y-3 pt-1">
              {/* Notion Connector Card */}
              <div className="flex items-center justify-between gap-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/50 p-4.5 transition-all">
                <div className="flex items-center gap-3.5 min-w-0">
                  <div className="size-9 rounded-lg border border-zinc-100 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800/80 flex items-center justify-center shrink-0 text-foreground">
                    <NotionLogo className="size-4.5" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-foreground">
                        Notion
                      </span>
                      <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-muted-foreground border border-zinc-200/60 dark:border-zinc-700">
                        Instant sync
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground truncate sm:whitespace-normal">
                      Sync docs, databases, and meeting notes from your
                      workspace.
                    </p>
                  </div>
                </div>

                <div className="shrink-0">
                  {connections.notion ? (
                    <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/60 text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                      <Check className="size-3.5 stroke-[3]" /> Connected
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleConnect("notion")}
                      disabled={!connectors.notion || connecting === "notion"}
                      className="inline-flex items-center justify-center gap-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-700 px-3.5 py-1.5 text-xs font-medium text-foreground transition-all shadow-2xs disabled:opacity-50"
                    >
                      {connecting === "notion" ? (
                        <Loader2 className="size-3.5 animate-spin text-primary" />
                      ) : (
                        <NotionLogo className="size-3.5" />
                      )}
                      Connect Notion
                    </button>
                  )}
                </div>
              </div>

              {/* YouTube Connector Card */}
              <div className="flex items-center justify-between gap-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/50 p-4.5 transition-all">
                <div className="flex items-center gap-3.5 min-w-0">
                  <div className="size-9 rounded-lg border border-zinc-100 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800/80 flex items-center justify-center shrink-0 text-foreground">
                    <YouTubeLogo className="size-4.5" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-foreground">
                        YouTube
                      </span>
                      <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-muted-foreground border border-zinc-200/60 dark:border-zinc-700">
                        Captions
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground truncate sm:whitespace-normal">
                      Import video transcripts, talks, and instructional
                      recordings.
                    </p>
                  </div>
                </div>

                <div className="shrink-0">
                  {connections.youtube ? (
                    <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/60 text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                      <Check className="size-3.5 stroke-[3]" /> Connected
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleConnect("youtube")}
                      disabled={!connectors.youtube || connecting === "youtube"}
                      className="inline-flex items-center justify-center gap-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-700 px-3.5 py-1.5 text-xs font-medium text-foreground transition-all shadow-2xs disabled:opacity-50"
                    >
                      {connecting === "youtube" ? (
                        <Loader2 className="size-3.5 animate-spin text-primary" />
                      ) : (
                        <YouTubeLogo className="size-3.5" />
                      )}
                      Connect YouTube
                    </button>
                  )}
                </div>
              </div>
            </div>

            {error && (
              <p
                role="alert"
                className="text-xs font-medium text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-100 dark:border-rose-900/50 rounded-lg p-3"
              >
                {error}
              </p>
            )}

            {/* Navigation Actions */}
            <div className="flex items-center justify-between pt-4">
              <span />
              {hasAnyConnection ? (
                <button
                  type="button"
                  onClick={handleGoToDashboard}
                  className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-6 py-2.5 text-sm font-medium text-primary-foreground shadow-sm hover:bg-primary/90 transition-all active:scale-[0.99]"
                >
                  Continue to dashboard <ArrowRight className="size-4" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleGoToDashboard}
                  className="inline-flex items-center justify-center gap-2 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 hover:bg-zinc-50 dark:hover:bg-zinc-800 px-5 py-2.5 text-sm font-medium text-foreground transition-all"
                >
                  Skip for now <ArrowRight className="size-4" />
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
