"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronRight, Plus } from "lucide-react";
import { toast } from "sonner";
import { BotIcon } from "@/components/icons";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { PageSection, SECTION_CARD, SectionRow } from "@/components/page-section";
import { SwitchToggle } from "@/components/switch-toggle";
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
export function TwinBotsPage({ data }: { data: Bots }) {
  const [creating, setCreating] = useState(false);
  return (
    <PageContainer>
      <PageHeader
        icon={BotIcon}
        title="Bots"
        description="What signed-out visitors talk to on your websites: a persona, a purpose and the skills it draws on."
        actions={<Button variant="brand" onClick={() => setCreating(true)}><Plus data-icon="inline-start" /> New bot</Button>}
      />
      <div className="mt-6">
        <PageSection title="Your bots" description="Each bot speaks as one persona, yours or a custom one.">
          {data.bots.length ? (
            <ul className={cn(SECTION_CARD, "m-0 list-none overflow-hidden p-0")}>
              {data.bots.map((bot) => (
                <li key={bot.slug} className="border-t border-(--border) first:border-t-0">
                  <Link href={dashRoute(`/bots/${encodeURIComponent(bot.slug)}`)}
                    className="flex items-center justify-between gap-4 px-5 py-4 transition-colors hover:bg-muted/40">
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{bot.name}</span>
                      <span className="block truncate text-sm text-muted-foreground">
                        Speaks as {bot.persona.name} · {status(bot)}
                      </span>
                    </span>
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <div className={cn(SECTION_CARD, "px-5 py-6 text-center text-sm text-muted-foreground")}>
              No bots yet. Create one to let visitors talk to you on your website.
            </div>
          )}
        </PageSection>
      </div>
      <NewBotDialog open={creating} onOpenChange={setCreating} personas={data.personas} />
    </PageContainer>
  );
}

function status(bot: Pick<Bot, "publicAccess" | "widget">) {
  if (!bot.publicAccess.enabled) return "Off";
  const websites = bot.widget.config.allowedOrigins.length;
  return websites ? `On · ${websites} ${websites === 1 ? "website" : "websites"}` : "On · link only";
}

/** Persona, name and purpose; opens the new bot's page with calls still off. */
function NewBotDialog({ open, onOpenChange, personas }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  personas: Bots["personas"];
}) {
  const router = useRouter();
  const [personaId, setPersonaId] = useState(personas[0]?.id ?? "");
  const [name, setName] = useState("");
  const [objective, setObjective] = useState("");
  const [busy, setBusy] = useState(false);
  async function create() {
    if (!personaId || !name.trim() || !objective.trim()) {
      toast.error(!personaId ? "Choose who the bot speaks as" : !name.trim() ? "Enter a name for the bot" : "Describe what the bot is for");
      return;
    }
    setBusy(true);
    try {
      const { slug } = await twinClient.bots.create.mutate({ personaId, name: name.trim(), objective: objective.trim() });
      toast.success("Bot created. Add its skills, then turn on public calls when it’s ready.");
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
            <DialogDescription>Who it speaks as and what it’s for. Public calls start off.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <label htmlFor="new-bot-persona" className="text-sm font-medium">Speaks as</label>
            <NativeSelect id="new-bot-persona" value={personaId} onChange={(event) => setPersonaId(event.target.value)}>
              {personas.map((persona) => <option key={persona.id} value={persona.id}>{persona.name}{persona.own ? " (you)" : ""}</option>)}
            </NativeSelect>
          </div>
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
        back={{ href: dashRoute("/bots"), label: "Bots" }}
        title={bot.name}
        description={<>Speaks as {bot.persona.name}.</>}
        actions={<Button variant="outline" size="lg" onClick={() => setConfirming(true)}>Delete bot</Button>}
      />
      <section aria-label="Website bot settings" className="mt-6">
        <div className="flex flex-col gap-10">
          <BotSkillsSection bot={bot} />
          <PublicAccessPanel bot={bot} />
        </div>
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

/**
 * Who the bot speaks as and the supporting skills it draws on (in order, each switchable). Saved together from the bar;
 * calls in progress keep what they started with.
 */
function BotSkillsSection({ bot }: { bot: Bot }) {
  const refresh = useRefresh();
  const initial = () => ({ personaId: bot.persona.id, skills: bot.skills.map((skill) => ({ skillId: skill.id, active: skill.active })) });
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [received, setReceived] = useState(bot);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial());
  if (received !== bot) {
    setReceived(bot);
    if (!dirty) setDraft(initial());
  }
  const attached = new Set(draft.skills.map((skill) => skill.skillId));
  const nameOf = new Map(bot.choices.skills.map((skill) => [skill.id, skill]));
  async function save() {
    setBusy(true);
    try {
      await twinClient.bots.update.mutate({ slug: bot.slug, personaId: draft.personaId, skills: draft.skills });
      toast.success("Bot saved");
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the bot");
    } finally {
      setBusy(false);
    }
  }
  return (
    <PageSection title="Persona and skills" description="Who the bot speaks as, and the skills it can draw on in a call.">
      <form className={cn(SECTION_CARD, "min-w-0 overflow-hidden")} onSubmit={(event) => { event.preventDefault(); if (dirty) void save(); }}>
        <fieldset disabled={busy} className="m-0 min-w-0">
          <SectionRow title={<label htmlFor="bot-persona">Speaks as</label>} detail="Its voice, photo and name. Yours or a custom persona.">
            <NativeSelect id="bot-persona" value={draft.personaId} onChange={(event) => setDraft({ ...draft, personaId: event.target.value })}>
              {bot.choices.personas.map((persona) => <option key={persona.id} value={persona.id}>{persona.name}{persona.own ? " (you)" : ""}</option>)}
            </NativeSelect>
          </SectionRow>
          <div className="flex flex-col gap-3 border-t border-(--border) px-5 py-4">
            <div>
              <div className="text-sm font-medium">Supporting skills</div>
              <p className="m-0 mt-0.5 text-sm text-muted-foreground">Published twin skills it may use. Switch one off to keep it attached but unused.</p>
            </div>
            {draft.skills.length ? (
              <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Supporting skills">
                {draft.skills.map((skill) => (
                  <li key={skill.skillId} className="flex items-center justify-between gap-3 rounded-tt-md border border-(--border) px-3 py-2">
                    <span className="min-w-0 truncate text-sm">{nameOf.get(skill.skillId)?.name ?? skill.skillId}</span>
                    <span className="flex shrink-0 items-center gap-2">
                      <SwitchToggle checked={skill.active} label={`Use ${nameOf.get(skill.skillId)?.name ?? "skill"}`}
                        onChange={(active) => setDraft({ ...draft, skills: draft.skills.map((row) => row.skillId === skill.skillId ? { ...row, active } : row) })} />
                      <Button type="button" variant="ghost" onClick={() => setDraft({ ...draft, skills: draft.skills.filter((row) => row.skillId !== skill.skillId) })}>Remove</Button>
                    </span>
                  </li>
                ))}
              </ul>
            ) : <p className="m-0 text-sm text-muted-foreground">No skills yet: the bot answers from its purpose only.</p>}
            {bot.choices.skills.some((skill) => !attached.has(skill.id)) ? (
              <NativeSelect aria-label="Add a skill" value="" onChange={(event) => {
                if (event.target.value) setDraft({ ...draft, skills: [...draft.skills, { skillId: event.target.value, active: true }] });
              }}>
                <option value="">Add a skill…</option>
                {bot.choices.skills.filter((skill) => !attached.has(skill.id)).map((skill) => <option key={skill.id} value={skill.id}>{skill.name}</option>)}
              </NativeSelect>
            ) : null}
          </div>
        </fieldset>
        {dirty ? (
          <div className="flex items-center justify-end gap-2 border-t border-(--border) bg-muted/30 px-5 py-3">
            <span className="mr-auto text-sm text-muted-foreground" role="status">Unsaved changes</span>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => setDraft(initial())}>Discard</Button>
            <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
          </div>
        ) : null}
      </form>
    </PageSection>
  );
}
