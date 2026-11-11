"use client";

import { useState, type CSSProperties } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronRight, ExternalLink, Lock, LogIn, LogOut, Sparkles } from "lucide-react";
import { EmailCodeSignInLink } from "@/components/auth/email-code-sign-in-link";
import { GoogleSignInButton } from "@/components/auth/google-sign-in-button";
import { PhoneIcon } from "@/components/calibration/call-icons";
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

const LABEL = "m-0 text-overline font-medium tracking-overline text-muted-foreground uppercase";

type OrgHomeTwin = {
  href: string;
  trainer: Trainer;
  twin: Twin;
  access: LearnerAccess;
  /** The trainer's skill twins: what they coach on (names only; their descriptions are written for trainers). */
  topics: { name: string }[];
};
type OrgHomeRoleplay = { name: string; description: string | null; href: string; expiresAt: string };

/**
 * The org's home page (<org>.<base>/, lib/pages/org-home.ts), laid out like a Delphi profile: the trainer (photo, role,
 * about), what they coach on, then your role plays; a call dock at the bottom. Anyone can look;
 * signing in (Google, back to this page) is needed to do anything. A learner invited to the org lands here.
 */
export function OrgHome({ org, viewer, twins, trainer, roleplays }: {
  org: { name: string; websiteUrl: string | null };
  viewer: { name: string; email: string; studio: boolean; minutesLeft: number | null } | null;
  twins: OrgHomeTwin[];
  /** The org's trainer when it has no main twin yet: shown, with nothing to start. */
  trainer: Trainer | null;
  roleplays: OrgHomeRoleplay[];
}) {
  const refresh = useRefresh();
  const router = useRouter();
  const [signingIn, setSigningIn] = useState(false);
  const [main, ...others] = twins;
  const coach = main ? firstName(main.trainer.name) : org.name;
  const blocked = main?.access && !main.access.ok ? noAccessCopy(main.access.reason, coach, main.access.message) : null;
  const usable = twins.some((item) => item.access?.ok) || roleplays.length > 0;
  const website = org.websiteUrl && hostOf(org.websiteUrl) ? { url: org.websiteUrl, host: hostOf(org.websiteUrl) } : null;

  /** Talk to the main twin: sign in first, then its page (where the call starts). */
  function start() {
    if (!viewer) return setSigningIn(true);
    if (main?.access?.ok) router.push(main.href);
  }

  function switchAccount() {
    void authClient.signOut().finally(() => {
      refresh();
      setSigningIn(true);
    });
  }

  return (
    <div className="flex min-h-svh flex-col bg-background">
      <header className="flex h-14 w-full shrink-0 items-center justify-between gap-3 px-5">
        <span className="flex min-w-0 items-center gap-1.5">
          <BrandMark className="size-5 shrink-0 text-primary" />
          <span className="text-base leading-none font-semibold tracking-title">TrainerTwin</span>
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

      <main className={cn("mx-auto flex w-full max-w-[640px] flex-1 flex-col gap-4 px-5 pt-6", main && !blocked ? "pb-40" : "pb-16")}>
        {main ? (
          <>
            <TrainerCard trainer={main.trainer} orgName={org.name} />

            {/* What they coach on (their skill twins), each a way into a conversation. */}
            {main.topics.length ? (
              <section className={cn(CARD, "flex flex-col gap-2 p-5")}>
                <h2 className={TITLE}>What brings you to {coach}?</h2>
                <ul className="m-0 flex list-none flex-col p-0">
                  {main.topics.map((topic, index) => (
                    <li key={topic.name} className={cn(index > 0 && "border-t border-(--card-border)")}>
                      <button
                        type="button"
                        onClick={start}
                        disabled={Boolean(blocked)}
                        className="flex w-full items-center gap-3 py-3 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50 enabled:cursor-pointer disabled:cursor-default"
                      >
                        <span className="min-w-0 flex-1 text-body leading-6 font-medium">{topic.name}</span>
                        {blocked ? null : <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

          </>
        ) : trainer ? (
          <TrainerCard trainer={trainer} orgName={org.name} />
        ) : (
          <section className="flex flex-col gap-1">
            <h1 className="m-0 text-2xl leading-9 font-semibold tracking-title">{org.name}</h1>
            <p className="m-0 text-body text-(--text-secondary)">Practise with {org.name}&apos;s trainers.</p>
          </section>
        )}

        {/* Where you stand: sign in, your minutes, or why you can't talk yet. */}
        {!viewer ? (
          <article className={cn(CARD, "flex flex-col gap-3 p-5")}>
            <h2 className={TITLE}>Sign in to start</h2>
            <p className={BODY}>Use the email you were added with: Google, or a code we email you. You&apos;ll see what you can practise, and your minutes.</p>
            <GoogleSignInButton callbackURL={typeof window === "undefined" ? "/" : `${window.location.origin}/`} className="h-10 w-full" />
            <EmailCodeSignInLink />
          </article>
        ) : blocked && main?.access ? (
          <article className={cn(CARD, "flex items-start gap-4 p-5")}>
            <span className="grid size-10 shrink-0 place-items-center rounded-full bg-(--tone-control) text-(--text-secondary)">
              <Lock className="size-[18px]" />
            </span>
            <div className="flex min-w-0 flex-col gap-1">
              <h3 className="m-0 text-body leading-6 font-semibold">{blocked.title}</h3>
              <p className="m-0 text-sm text-muted-foreground">{blocked.body}</p>
              <p className="mt-2 mb-0 text-xs text-muted-foreground">
                Signed in as {main.access.email} ·{" "}
                <button type="button" className="font-medium text-foreground underline-offset-2 hover:underline" onClick={switchAccount}>
                  Switch account
                </button>
              </p>
            </div>
          </article>
        ) : main?.access?.ok && !main.access.preview ? (
          <article className={cn(CARD, "flex flex-col gap-2 p-5")}>
            <p className="m-0 flex items-baseline justify-between gap-3 text-sm">
              <span className="font-medium">You&apos;re in, {firstName(main.access.name)}</span>
              <span className="text-muted-foreground tabular-nums">{main.access.minutesLeft} of {main.access.minutesTotal} min left</span>
            </p>
            <span className="block h-1.5 w-full overflow-hidden rounded-full bg-(--tone-control)">
              <span className="block h-full w-(--w) rounded-full bg-foreground" style={{ "--w": `${Math.min(100, Math.round((main.access.minutesLeft / Math.max(1, main.access.minutesTotal)) * 100))}%` } as CSSProperties} />
            </span>
          </article>
        ) : viewer.studio ? (
          <p className="m-0 text-sm text-muted-foreground">You&apos;re previewing what learners see. Your calls here use no minutes and aren&apos;t counted.</p>
        ) : !usable ? (
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

        {roleplays.length > 0 ? (
          <section className="flex flex-col gap-3">
            <h2 className="mt-4 mb-0 text-section-title leading-6 font-semibold tracking-title">Your role plays</h2>
            {roleplays.map((roleplay) => (
              <article key={roleplay.href} className={cn(CARD, "flex flex-col gap-3 p-5")}>
                <div className="flex flex-col gap-1">
                  <h3 className={TITLE}>{roleplay.name}</h3>
                  {roleplay.description ? <p className={cn(BODY, "line-clamp-3")}>{roleplay.description}</p> : null}
                </div>
                <Button variant="outline" className="w-fit" nativeButton={false} render={<Link href={roleplay.href} />}>
                  <Sparkles data-icon="inline-start" />
                  Start role play
                </Button>
              </article>
            ))}
          </section>
        ) : null}

        {others.length > 0 ? (
          <section className="flex flex-col gap-3">
            <h2 className="mt-4 mb-0 text-section-title leading-6 font-semibold tracking-title">More trainers at {org.name}</h2>
            {others.map((item) => <OtherTrainer key={item.href} item={item} signedIn={Boolean(viewer)} onSignIn={() => setSigningIn(true)} />)}
          </section>
        ) : null}

        {website ? (
          <section className="mt-4 flex flex-col gap-2">
            <p className={LABEL}>Follow {org.name} for more</p>
            <a href={website.url} target="_blank" rel="noopener noreferrer" className="inline-flex w-fit items-center gap-1.5 text-sm font-medium underline-offset-2 hover:underline">
              {website.host}
              <ExternalLink className="size-3.5 text-muted-foreground" aria-hidden />
            </a>
          </section>
        ) : null}
      </main>

      {/* Call dock, as on the twin's page: one clear action. Hidden when there's no twin or no access. */}
      {main && !blocked ? (
        <div className="fixed inset-x-0 bottom-0 z-10 flex flex-col items-center gap-2 bg-linear-to-t from-background via-background/90 to-transparent px-5 pt-10 pb-5">
          <div className="flex items-center gap-3 rounded-full border border-(--card-border) bg-card p-1.5 shadow-elevation-2">
            <Button size="xl" variant="brand" onClick={start}>
              <PhoneIcon data-icon="inline-start" className="size-[18px]" />
              {main.access?.ok ? `Talk to ${coach}'s twin` : "Start conversation"}
            </Button>
          </div>
          <p className="m-0 text-xs text-muted-foreground">Conversations are recorded to help you and {coach}.</p>
        </div>
      ) : null}

      <Dialog open={signingIn} onOpenChange={setSigningIn}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader className="items-center text-center">
            {main ? <TwinPortrait name={main.trainer.name} photoUrl={main.trainer.photoUrl} className="mb-2 size-16 rounded-2xl text-2xl" /> : null}
            <DialogTitle>Sign in to continue with {coach}</DialogTitle>
            <DialogDescription>Use the email you were added with: Google, or a code we email you. Your minutes and sessions stay yours.</DialogDescription>
          </DialogHeader>
          <GoogleSignInButton callbackURL={typeof window === "undefined" ? "/" : `${window.location.origin}/`} className="h-10 w-full" />
            <EmailCodeSignInLink />
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** The trainer, as on their twin's page: photo, full name, role · place, and about. */
function TrainerCard({ trainer, orgName }: { trainer: Trainer; orgName: string }) {
  return (
    <section className={cn(CARD, "flex flex-col gap-5")}>
      <div className="flex items-center gap-5">
        <TwinPortrait name={trainer.name} photoUrl={trainer.photoUrl} className="size-24 shrink-0 rounded-3xl text-4xl shadow-elevation-2 sm:size-28 sm:rounded-4xl" />
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="m-0 text-2xl leading-9 font-semibold tracking-title">{trainer.name}</h1>
          {trainer.title ? <p className="m-0 text-body text-(--text-secondary)">{trainer.title}</p> : null}
          {/* The org, unless it's named after the trainer ("Olga" for Olga Sinenko). */}
          {trainer.name.toLowerCase().includes(orgName.toLowerCase()) ? null : <p className="m-0 text-sm text-muted-foreground">{orgName}</p>}
        </div>
      </div>
      {trainer.bio ? (
        <div className="flex flex-col gap-2">
          <p className={LABEL}>About</p>
          <p className={BODY}>{trainer.bio}</p>
        </div>
      ) : null}
    </section>
  );
}

/** Another trainer's twin at this org: who they are, and a way to it (or why not yet). */
function OtherTrainer({ item, signedIn, onSignIn }: { item: OrgHomeTwin; signedIn: boolean; onSignIn: () => void }) {
  const coach = firstName(item.trainer.name);
  const blocked = item.access && !item.access.ok ? noAccessCopy(item.access.reason, coach, item.access.message) : null;
  return (
    <article className={cn(CARD, "flex items-center gap-4 p-5")}>
      <TwinPortrait name={item.trainer.name} photoUrl={item.trainer.photoUrl} className="size-14 shrink-0 rounded-2xl text-xl" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <h3 className={TITLE}>{item.trainer.name}</h3>
        <p className="m-0 truncate text-sm text-muted-foreground">{blocked ? blocked.title : item.trainer.title ?? item.twin.name}</p>
      </div>
      {blocked ? null : signedIn ? (
        <Button variant="outline" nativeButton={false} render={<Link href={item.href} />}>Talk</Button>
      ) : (
        <Button variant="outline" onClick={onSignIn}>Sign in</Button>
      )}
    </article>
  );
}
