"use client";

import { useState } from "react";
import Link from "next/link";
import { ExternalLink, Lock, LogIn, LogOut, Sparkles } from "lucide-react";
import { GoogleSignInButton } from "@/components/auth/google-sign-in-button";
import { TwinPortrait } from "@/components/calibration/parts";
import { BrandMark } from "@/components/icons";
import { BODY, CARD, firstName, noAccessCopy, TITLE, type LearnerAccess, type Trainer, type Twin } from "@/components/twin/twin-learner-flow";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { UserAvatar } from "@/components/user-avatar";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/utils";
import { useRefresh } from "@/lib/use-refresh";

/** A website's host for display ("acme.com"); null for a value that isn't a URL (old saved values). */
const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
};

type OrgHomeTwin = { href: string; trainer: Trainer; twin: Twin; access: LearnerAccess };
type OrgHomeRoleplay = { name: string; description: string | null; href: string; expiresAt: string };

/**
 * The org's home page (<org>.<base>/, lib/pages/org-home.ts): anyone can see the org and its trainers' twins; signing
 * in (Google, back to this page) is needed to do anything. Signed in: your minutes, each twin with your access to it,
 * and the role plays assigned to you. A learner invited to the org lands here from their invite email.
 */
export function OrgHome({ org, viewer, twins, roleplays }: {
  org: { name: string; logo: string | null; websiteUrl: string | null };
  viewer: { name: string; email: string; studio: boolean; minutesLeft: number | null } | null;
  twins: OrgHomeTwin[];
  roleplays: OrgHomeRoleplay[];
}) {
  const refresh = useRefresh();
  const [signingIn, setSigningIn] = useState(false);
  const usable = twins.some((item) => item.access?.ok) || roleplays.length > 0;

  function switchAccount() {
    void authClient.signOut().finally(() => {
      refresh();
      setSigningIn(true);
    });
  }

  return (
    <div className="flex min-h-svh flex-col bg-background">
      <header className="flex h-14 w-full shrink-0 items-center justify-between gap-3 px-5">
        <span className="flex min-w-0 items-center gap-2">
          {org.logo ? (
            // eslint-disable-next-line @next/next/no-img-element -- the org's own logo, a data URL
            <img src={org.logo} alt="" className="size-6 shrink-0 rounded-md object-contain" />
          ) : (
            <BrandMark className="size-5 shrink-0 text-primary" />
          )}
          <span className="truncate text-base leading-none font-semibold tracking-title">{org.name}</span>
          {viewer?.studio ? <span className="ml-1 rounded-full bg-(--brand)/10 px-2.5 py-0.5 text-xs font-medium text-(--brand)">Preview</span> : null}
        </span>
        {viewer ? (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="lg" />}>
              <span data-icon="inline-start" className="-ml-2">
                <UserAvatar user={{ name: viewer.name, email: viewer.email }} size="sm" />
              </span>
              <span className="max-w-[140px] truncate">{firstName(viewer.name)}</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" sideOffset={6} className="w-56">
              <DropdownMenuGroup>
                <DropdownMenuLabel className="truncate font-normal">{viewer.email}</DropdownMenuLabel>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem onClick={switchAccount}>
                  <LogOut />
                  Switch account
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <Button variant="ghost" className="h-9" onClick={() => setSigningIn(true)}>
            <LogIn data-icon="inline-start" />
            Sign in
          </Button>
        )}
      </header>

      <main className="mx-auto flex w-full max-w-[640px] flex-1 flex-col gap-4 px-5 pt-8 pb-16">
        <section className="flex flex-col gap-1">
          <h1 className="m-0 text-2xl leading-9 font-semibold tracking-title">{org.name}</h1>
          <p className="m-0 text-body text-(--text-secondary)">Practise with {org.name}&apos;s trainers: talk to their twins and try the role plays they give you.</p>
          {org.websiteUrl && hostOf(org.websiteUrl) ? (
            <a href={org.websiteUrl} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex w-fit items-center gap-1 text-sm text-muted-foreground underline-offset-2 hover:underline">
              {hostOf(org.websiteUrl)}
              <ExternalLink className="size-3.5" aria-hidden />
            </a>
          ) : null}
        </section>

        {!viewer ? (
          <article className={cn(CARD, "flex flex-col gap-3 p-5")}>
            <h2 className={TITLE}>Sign in to start</h2>
            <p className={BODY}>Use the Google account {org.name} invited. You&apos;ll see the twins and role plays you can use, and your minutes.</p>
            <GoogleSignInButton callbackURL={typeof window === "undefined" ? "/" : `${window.location.origin}/`} className="h-10 w-full" />
          </article>
        ) : viewer.minutesLeft !== null ? (
          <p className="m-0 text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{viewer.minutesLeft} min</span> of practice left, shared by everything below.
          </p>
        ) : null}

        {twins.length > 0 ? (
          <>
            <h2 className="mt-4 mb-0 text-section-title leading-6 font-semibold tracking-title">Twins</h2>
            {twins.map((item) => <TwinCard key={item.href} item={item} signedIn={Boolean(viewer)} onSignIn={() => setSigningIn(true)} />)}
          </>
        ) : null}

        {roleplays.length > 0 ? (
          <>
            <h2 className="mt-4 mb-0 text-section-title leading-6 font-semibold tracking-title">Role plays</h2>
            {roleplays.map((roleplay) => (
              <article key={roleplay.href} className={cn(CARD, "flex flex-col gap-3 p-5")}>
                <div className="flex flex-col gap-1">
                  <h3 className={TITLE}>{roleplay.name}</h3>
                  {roleplay.description ? <p className={BODY}>{roleplay.description}</p> : null}
                </div>
                <Button variant="brand" className="w-fit" nativeButton={false} render={<Link href={roleplay.href} />}>
                  <Sparkles data-icon="inline-start" />
                  Start role play
                </Button>
              </article>
            ))}
          </>
        ) : null}

        {viewer && !viewer.studio && !usable ? (
          <article className={cn(CARD, "flex items-start gap-4 p-5")}>
            <span className="grid size-10 shrink-0 place-items-center rounded-full bg-(--tone-control) text-(--text-secondary)">
              <Lock className="size-[18px]" />
            </span>
            <div className="flex min-w-0 flex-col gap-1">
              <h3 className="m-0 text-body leading-6 font-semibold">Nothing assigned to you yet</h3>
              <p className="m-0 text-sm text-muted-foreground">When your trainer gives you a twin or a role play, it shows up here.</p>
              <p className="mt-2 mb-0 text-xs text-muted-foreground">
                Signed in as {viewer.email} ·{" "}
                <button type="button" className="font-medium text-foreground underline-offset-2 hover:underline" onClick={switchAccount}>
                  Switch account
                </button>
              </p>
            </div>
          </article>
        ) : null}
      </main>

      <Dialog open={signingIn} onOpenChange={setSigningIn}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader className="items-center text-center">
            <DialogTitle>Sign in to {org.name}</DialogTitle>
            <DialogDescription>Use the Google account {org.name} invited. Your minutes and sessions stay yours.</DialogDescription>
          </DialogHeader>
          <GoogleSignInButton callbackURL={typeof window === "undefined" ? "/" : `${window.location.origin}/`} className="h-10 w-full" />
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** A trainer's twin as on its /t page (portrait, trainer, twin), with what you can do: open it, or why you can't yet. */
function TwinCard({ item, signedIn, onSignIn }: { item: OrgHomeTwin; signedIn: boolean; onSignIn: () => void }) {
  const { trainer, twin, access, href } = item;
  const coach = firstName(trainer.name);
  const blocked = access && !access.ok ? noAccessCopy(access.reason, coach) : null;
  return (
    <article className={cn(CARD, "flex flex-col gap-4 p-5")}>
      <div className="flex items-center gap-4">
        <TwinPortrait name={trainer.name} photoUrl={trainer.photoUrl} className="size-16 shrink-0 rounded-2xl text-2xl" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 className={TITLE}>{trainer.name}</h3>
          {trainer.title ? <p className="m-0 text-sm text-(--text-secondary)">{trainer.title}</p> : null}
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <p className="m-0 text-body leading-6 font-semibold">{twin.name}</p>
        {twin.description ? <p className={BODY}>{twin.description}</p> : null}
      </div>
      {blocked ? (
        <p className="m-0 flex items-start gap-2 border-t border-(--card-border) pt-4 text-sm text-muted-foreground">
          <Lock className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span><span className="font-medium text-foreground">{blocked.title}.</span> {blocked.body}</span>
        </p>
      ) : signedIn ? (
        <Button variant="brand" className="w-fit" nativeButton={false} render={<Link href={href} />}>
          Talk to {coach}&apos;s twin
        </Button>
      ) : (
        <Button variant="brand" className="w-fit" onClick={onSignIn}>
          <LogIn data-icon="inline-start" />
          Sign in to talk to {coach}&apos;s twin
        </Button>
      )}
    </article>
  );
}
