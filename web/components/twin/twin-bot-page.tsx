"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronRight, Plus } from "lucide-react";
import { toast } from "sonner";
import { BotIcon } from "@/components/icons";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { PageSection, SECTION_CARD } from "@/components/page-section";
import { PublicAccessPanel } from "@/components/twin/public-access-panel";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { dashRoute } from "@/lib/routes";
import { twinClient } from "@/lib/twin/client";
import type { TwinOutputs } from "@/lib/twin/trpc";
import { useRefresh } from "@/lib/use-refresh";
import { cn } from "@/lib/utils";

type Bots = TwinOutputs["bots"]["list"];
type Bot = TwinOutputs["bots"]["get"];

/**
 * Website bots (sidebar, under Twin): the public side of the trainers' twins (lib/bots). A twin can have several bots,
 * say one per website, each with its own name, purpose, public call settings and widget.
 */
export function TwinBotsPage({ data, startFor }: { data: Bots; startFor?: string | null }) {
  const [creating, setCreating] = useState(Boolean(startFor) && data.twins.length > 0);
  return (
    <PageContainer>
      <PageHeader
        icon={BotIcon}
        title="Website bots"
        description="What signed-out visitors talk to, on your twin’s link and your own websites."
        actions={data.twins.length ? (
          <Button variant="brand" onClick={() => setCreating(true)}><Plus data-icon="inline-start" /> New bot</Button>
        ) : null}
      />
      <div className="mt-6">
        <PageSection title="Bots" description="Each bot speaks as one of your twins, with its voice and skills.">
          {data.bots.length ? (
            <ul className={cn(SECTION_CARD, "m-0 list-none overflow-hidden p-0")}>
              {data.bots.map((bot) => (
                <li key={bot.slug} className="border-t border-(--border) first:border-t-0">
                  <Link href={dashRoute(`/bots/${encodeURIComponent(bot.slug)}`)}
                    className="flex items-center justify-between gap-4 px-5 py-4 transition-colors hover:bg-muted/40">
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{bot.name}</span>
                      <span className="block truncate text-sm text-muted-foreground">
                        {bot.twin ? `Speaks as ${bot.twin.name}` : bot.trainer} · {status(bot)}
                      </span>
                    </span>
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <div className={cn(SECTION_CARD, "px-5 py-6 text-center text-sm text-muted-foreground")}>
              {data.twins.length ? "No bots yet. Create one to let visitors talk to your twin." : "Create a twin first: then add its bots here."}
            </div>
          )}
        </PageSection>
      </div>
      <NewBotDialog open={creating} onOpenChange={setCreating} twins={data.twins} startFor={startFor} />
    </PageContainer>
  );
}

function status(bot: Pick<Bot, "publicAccess" | "widget">) {
  if (!bot.publicAccess.enabled) return "Off";
  const websites = bot.widget.config.allowedOrigins.length;
  return websites ? `On · ${websites} ${websites === 1 ? "website" : "websites"}` : "On · link only";
}

/** Name, purpose and (with several trainers) which twin it speaks as; opens the new bot's page, calls still off. */
function NewBotDialog({ open, onOpenChange, twins, startFor }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  twins: Bots["twins"];
  startFor?: string | null;
}) {
  const router = useRouter();
  const [twinSlug, setTwinSlug] = useState(twins.find((twin) => twin.slug === startFor)?.slug ?? twins[0]?.slug ?? "");
  const [name, setName] = useState("");
  const [objective, setObjective] = useState("");
  const [busy, setBusy] = useState(false);
  async function create() {
    if (!name.trim() || !objective.trim()) {
      toast.error(!name.trim() ? "Enter a name for the bot" : "Describe what the bot is for");
      return;
    }
    setBusy(true);
    try {
      const { slug } = await twinClient.bots.create.mutate({ twinSlug, name: name.trim(), objective: objective.trim() });
      toast.success("Bot created. Turn on public calls when it’s ready.");
      router.push(dashRoute(`/bots/${encodeURIComponent(slug)}`));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create the bot");
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void create(); }}>
          <DialogHeader>
            <DialogTitle className="text-lg">New bot</DialogTitle>
            <DialogDescription>It speaks with the twin’s voice and skills. Public calls start off.</DialogDescription>
          </DialogHeader>
          {twins.length > 1 ? (
            <div className="flex flex-col gap-2">
              <label htmlFor="new-bot-twin" className="text-sm font-medium">Speaks as</label>
              <NativeSelect id="new-bot-twin" value={twinSlug} onChange={(event) => setTwinSlug(event.target.value)}>
                {twins.map((twin) => <option key={twin.slug} value={twin.slug}>{twin.name} ({twin.trainer})</option>)}
              </NativeSelect>
            </div>
          ) : null}
          <div className="flex flex-col gap-2">
            <label htmlFor="new-bot-name" className="text-sm font-medium">Name</label>
            <Input id="new-bot-name" maxLength={120} value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Homepage assistant" />
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor="new-bot-purpose" className="text-sm font-medium">Purpose</label>
            <Textarea id="new-bot-purpose" rows={4} maxLength={2000} value={objective} onChange={(event) => setObjective(event.target.value)}
              placeholder="e.g. Answer questions about my coaching and suggest booking a call." className="min-h-24" />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" variant="brand" disabled={busy}>{busy ? "Creating…" : "Create bot"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** One bot: its public calls, own name and purpose, and website widget. */
export function TwinBotPage({ bot }: { bot: Bot }) {
  const router = useRouter();
  const refresh = useRefresh();
  const [confirming, setConfirming] = useState(false);
  async function archive() {
    try {
      await twinClient.bots.archive.mutate({ slug: bot.slug });
      toast.success("Bot deleted");
      refresh();
      router.push(dashRoute("/bots"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not delete the bot");
    }
  }
  return (
    <PageContainer>
      <PageHeader
        back={{ href: dashRoute("/bots"), label: "Website bots" }}
        title={bot.name}
        description={bot.twin
          ? <>Speaks as <Link href={dashRoute(`/twin/${encodeURIComponent(bot.twin.slug)}`)} className="text-foreground underline-offset-4 hover:underline">{bot.twin.name}</Link>, with the same voice and skills.</>
          : <>Speaks as {bot.trainer}.</>}
        actions={<Button variant="outline" size="lg" onClick={() => setConfirming(true)}>Delete bot</Button>}
      />
      <section aria-label="Website bot settings" className="mt-6">
        <PublicAccessPanel bot={bot} />
      </section>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {bot.name}?</AlertDialogTitle>
            <AlertDialogDescription>Its widget stops on every website at once. Past calls stay in Twin sessions.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void archive()}>Delete bot</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageContainer>
  );
}
