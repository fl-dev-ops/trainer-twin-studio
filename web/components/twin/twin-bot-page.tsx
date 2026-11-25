"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Check, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { SupportingSkillsEditor } from "@/components/agents/supporting-skills-editor";
import { BotIcon } from "@/components/icons";
import { DotsIcon, GRADIENTS } from "@/components/library-card-parts";
import { PageContainer } from "@/components/page-container";
import { PageSection, SECTION_CARD, SectionRow } from "@/components/page-section";
import { PersonaPicker } from "@/components/roleplay/roleplay-builder-page";
import { PublicAccessPanel } from "@/components/twin/public-access-panel";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { UserAvatar } from "@/components/user-avatar";
import { dashRoute } from "@/lib/routes";
import { twinClient } from "@/lib/twin/client";
import type { TwinOutputs } from "@/lib/twin/trpc";
import { useRefresh } from "@/lib/use-refresh";
import { cn } from "@/lib/utils";

type Bots = TwinOutputs["bots"]["list"];
type BotRow = Bots["bots"][number];
type Bot = TwinOutputs["bots"]["get"];
type PersonaChoice = Bots["personas"][number];

/** A persona choice in the shape the shared picker (role plays) shows: photo, name, role, "You". */
const pickerPersonas = (choices: PersonaChoice[]) =>
  choices.map((persona) => ({ slug: persona.slug, name: persona.name, role: persona.role ?? (persona.global ? "Library persona" : "Persona"), isOwn: persona.own, photoUrl: persona.photoUrl }));

function status(bot: Pick<BotRow, "publicAccess" | "widget">) {
  if (!bot.publicAccess.enabled) return { live: false, label: "Off" };
  const websites = bot.widget.config.allowedOrigins.length;
  return { live: websites > 0, label: websites ? `Live on ${websites} ${websites === 1 ? "website" : "websites"}` : "On · no websites yet" };
}

/** Actions of one bot (card menu and settings header share them). */
function BotMenu({ slug, name, trigger, onDelete }: { slug: string; name: string; trigger?: "card" | "header"; onDelete: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant={trigger === "header" ? "secondary" : "ghost"} iconOnly className={trigger === "header" ? undefined : "ml-auto"} aria-label={`Actions for ${name}`} />}
      >
        <DotsIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" align="end" className="w-44">
        <DropdownMenuGroup>
          {trigger !== "header" ? (
            <DropdownMenuItem render={<Link href={dashRoute(`/bots/${encodeURIComponent(slug)}`)} />}>
              <Pencil className="size-4" />
              <span>Edit</span>
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onClick={onDelete}>
            <Trash2 className="size-4" />
            <span>Delete</span>
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Confirms deleting a bot: its widget stops on every website at once; past calls stay. */
function DeleteBotDialog({ bot, open, onOpenChange, onDeleted }: { bot: { slug: string; name: string }; open: boolean; onOpenChange: (open: boolean) => void; onDeleted: () => void }) {
  async function archive() {
    try {
      await twinClient.bots.archive.mutate({ slug: bot.slug });
      toast.success("Bot deleted");
      onDeleted();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not delete the bot");
    }
  }
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {bot.name}?</AlertDialogTitle>
          <AlertDialogDescription>Its widget stops on every website at once. Past calls stay in its sessions.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => void archive()}>Delete bot</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** One bot (like a role play card): its persona and welcome on the art, name, purpose, status, actions. */
function BotCard({ bot, index, onDelete }: { bot: BotRow; index: number; onDelete: () => void }) {
  const state = status(bot);
  return (
    <article className="flex flex-col overflow-visible rounded-tt-md border border-(--card-border) bg-card text-left shadow-elevation-1 transition-shadow hover:shadow-elevation-2">
      <Link href={dashRoute(`/bots/${encodeURIComponent(bot.slug)}`)} className="block outline-none">
        <div className={cn("relative flex min-h-[176px] items-center justify-center rounded-t-tt-md p-4", GRADIENTS[index % GRADIENTS.length])}>
          <div className="relative w-full rounded-tt-md bg-card p-3.5 shadow-elevation-2">
            <span className="absolute top-full right-3 left-3 -z-10 -mt-2 h-4 rounded-b-tt-md bg-white/28 dark:bg-black/25" />
            <div className="flex items-center gap-3">
              <UserAvatar user={{ name: bot.persona.name, image: bot.persona.photoUrl }} size="xl" />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-body-s leading-body-s font-semibold text-(--foreground)">{bot.persona.name}</span>
                <span className="line-clamp-2 text-body-s leading-body-s text-(--text-secondary)" title={bot.widget.config.welcome}>“{bot.widget.config.welcome}”</span>
              </span>
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-2 px-4 pt-3.5 pb-0">
          <span className="line-clamp-1 text-body leading-body font-semibold tracking-title text-(--foreground)" title={bot.name}>{bot.name}</span>
          {bot.objective ? <span className="line-clamp-3 text-body-s leading-5 text-(--text-secondary)" title={bot.objective}>{bot.objective}</span> : null}
        </div>
      </Link>
      <div className="mt-auto flex items-center justify-between gap-2 px-4 pt-4 pb-4">
        <span className="inline-flex items-center gap-2 text-body-s text-muted-foreground">
          <span aria-hidden className={cn("size-2 rounded-full", state.live ? "bg-(--brand)" : "bg-(--tone-control)")} />
          {state.label}
        </span>
        <BotMenu slug={bot.slug} name={bot.name} onDelete={onDelete} />
      </div>
    </article>
  );
}

/** Bots: the library of channel agents (website widget now; WhatsApp, Slack later), in the Scenarios style. */
export function TwinBotsPage({ data }: { data: Bots }) {
  const refresh = useRefresh();
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<BotRow | null>(null);
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = q ? data.bots.filter((bot) => `${bot.name} ${bot.objective} ${bot.persona.name}`.toLowerCase().includes(q)) : data.bots;
  return (
    <PageContainer>
      <header className="flex min-h-10 items-center justify-between gap-4">
        <h1 className="m-0 flex items-center gap-2 text-page-title leading-page-title font-semibold tracking-title">
          <span className="grid size-7 place-items-center rounded-tt-sm text-(--text-secondary)">
            <BotIcon className="size-[18px]" />
          </span>
          Bots
        </h1>
        <div className="flex items-center gap-2">
          <label className="flex h-8 items-center gap-2 rounded-full border border-(--card-border) bg-card px-3 text-body-s text-muted-foreground focus-within:border-(--brand)">
            <Search className="size-4" aria-hidden />
            <span className="sr-only">Search bots</span>
            <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search..." autoComplete="off"
              className="w-36 bg-transparent text-foreground outline-none placeholder:text-muted-foreground" />
          </label>
          <Button type="button" onClick={() => setCreating(true)}>
            <Plus aria-hidden="true" />
            New bot
          </Button>
        </div>
      </header>

      <h2 className="mt-10 text-section-title leading-6 font-semibold tracking-title">Your bots</h2>
      <p className="m-0 mt-1 text-sm text-muted-foreground">Each bot speaks as one persona and serves a channel: your website’s voice widget today.</p>
      {shown.length ? (
        <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((bot, index) => <BotCard key={bot.slug} bot={bot} index={index} onDelete={() => setDeleting(bot)} />)}
        </div>
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">{q ? "No bots match that search." : "No bots yet. Create one with New bot."}</p>
      )}

      <NewBotDialog open={creating} onOpenChange={setCreating} personas={data.personas} />
      {deleting ? (
        <DeleteBotDialog bot={deleting} open onOpenChange={(open) => { if (!open) setDeleting(null); }} onDeleted={() => { setDeleting(null); refresh(); }} />
      ) : null}
    </PageContainer>
  );
}

/** Persona, name and purpose; opens the new bot's settings with public calls still off. */
function NewBotDialog({ open, onOpenChange, personas }: { open: boolean; onOpenChange: (open: boolean) => void; personas: PersonaChoice[] }) {
  const router = useRouter();
  const [personaSlug, setPersonaSlug] = useState(personas[0]?.slug ?? "");
  const [name, setName] = useState("");
  const [objective, setObjective] = useState("");
  const [busy, setBusy] = useState(false);
  async function create() {
    const persona = personas.find((row) => row.slug === personaSlug);
    if (!persona || !name.trim() || !objective.trim()) {
      toast.error(!persona ? "Choose who the bot speaks as" : !name.trim() ? "Enter a name for the bot" : "Describe what the bot is for");
      return;
    }
    setBusy(true);
    try {
      const { slug } = await twinClient.bots.create.mutate({ personaId: persona.id, name: name.trim(), objective: objective.trim() });
      toast.success("Bot created. Add its skills, then turn on public calls when it’s ready.");
      router.push(dashRoute(`/bots/${encodeURIComponent(slug)}`));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create the bot");
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(720px,calc(100dvh-2.2rem))] flex-col gap-4 sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle className="text-lg">New bot</DialogTitle>
          <DialogDescription>Who it speaks as and what it’s for. Public calls start off.</DialogDescription>
        </DialogHeader>
        <form id="new-bot" className="flex min-h-0 flex-col gap-4 overflow-y-auto" onSubmit={(event) => { event.preventDefault(); void create(); }}>
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">Speaks as</span>
            <PersonaPicker personas={pickerPersonas(personas)} value={personaSlug} onChange={setPersonaSlug} />
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
        </form>
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" form="new-bot" variant="default" disabled={busy}>{busy ? "Creating…" : "Create bot"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One bot's settings, laid out like the twin's: General, Persona & skills, Website widget. */
export function TwinBotPage({ bot }: { bot: Bot }) {
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);
  return (
    <PageContainer>
      <header className="flex min-h-10 items-center justify-between gap-4">
        <Link href={dashRoute("/bots")} className="inline-flex items-center gap-2 text-sm text-(--foreground) transition-colors hover:text-muted-foreground">
          <ArrowLeft className="size-4" />
          <span>Back</span>
        </Link>
      </header>

      <div className="mt-6 flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <UserAvatar user={{ name: bot.persona.name, image: bot.persona.photoUrl }} size="xl" />
          <div className="min-w-0">
            <h1 className="m-0 truncate text-title-m font-semibold leading-7 tracking-title">{bot.name}</h1>
            <p className="m-0 mt-1 text-sm text-muted-foreground">Speaks as {bot.persona.name} · {status(bot).label}</p>
          </div>
        </div>
        <BotMenu slug={bot.slug} name={bot.name} trigger="header" onDelete={() => setDeleting(true)} />
      </div>

      <div className="mt-6 flex flex-col gap-4">
        <Tabs defaultValue="general" className="min-w-0 gap-4">
          <TabsList className="max-w-full overflow-x-auto">
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="persona">
              Persona &amp; skills
              <span className="text-muted-foreground tabular-nums">· {bot.skills.filter((skill) => skill.active).length}</span>
            </TabsTrigger>
            <TabsTrigger value="widget">Website widget</TabsTrigger>
          </TabsList>
          <TabsContent value="general"><BotGeneral bot={bot} /></TabsContent>
          <TabsContent value="persona"><BotPersonaAndSkills bot={bot} /></TabsContent>
          <TabsContent value="widget">
            <section aria-label="Website bot settings">
              <PublicAccessPanel bot={bot} />
            </section>
          </TabsContent>
        </Tabs>
      </div>

      {deleting ? (
        <DeleteBotDialog bot={bot} open onOpenChange={setDeleting} onDeleted={() => router.push(dashRoute("/bots"))} />
      ) : null}
    </PageContainer>
  );
}

/** Name and purpose: saved together with Save changes, like the twin's General tab. */
function BotGeneral({ bot }: { bot: Bot }) {
  const refresh = useRefresh();
  const [name, setName] = useState(bot.name);
  const [objective, setObjective] = useState(bot.objective);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [received, setReceived] = useState(bot);
  if (received !== bot) {
    setReceived(bot);
    setName(bot.name);
    setObjective(bot.objective);
  }
  const dirty = name.trim() !== bot.name || objective.trim() !== bot.objective;
  async function save() {
    if (!name.trim() || !objective.trim()) {
      toast.error(!name.trim() ? "Enter a name for the bot" : "Describe what the bot is for");
      return;
    }
    setSaving(true);
    try {
      await twinClient.bots.update.mutate({ slug: bot.slug, name: name.trim(), objective: objective.trim() });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      toast.success("Bot saved");
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the bot");
    } finally {
      setSaving(false);
    }
  }
  return (
    <PageSection title="Name and purpose" description="What this bot’s visitors get. Its name and purpose are its own; twins and role plays aren’t affected.">
      <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); if (dirty) void save(); }}>
        <fieldset disabled={saving} className={cn(SECTION_CARD, "m-0 min-w-0")}>
          <SectionRow title={<label htmlFor="bot-name">Name</label>} detail="Shown on the call screen and the website widget.">
            <Input id="bot-name" className="w-full sm:w-80" maxLength={120} value={name} onChange={(event) => setName(event.target.value)} />
          </SectionRow>
          <div className="flex flex-col gap-3 border-t border-(--border) px-5 py-4">
            <div>
              <label htmlFor="bot-purpose" className="text-sm font-medium">Purpose</label>
              <p id="bot-purpose-help" className="m-0 mt-0.5 text-sm text-muted-foreground">What the bot is for and how it should help visitors, e.g. answer questions about your coaching and suggest a next step.</p>
            </div>
            <Textarea id="bot-purpose" rows={5} maxLength={2000} value={objective} aria-describedby="bot-purpose-help"
              onChange={(event) => setObjective(event.target.value)} className="min-h-32" />
          </div>
        </fieldset>
        <div className="flex items-center justify-end gap-3">
          <Button type="button" variant="ghost" disabled={saving || !dirty} onClick={() => { setName(bot.name); setObjective(bot.objective); }}>Cancel</Button>
          <Button variant="default" type="submit" disabled={saving || !dirty}>
            {saved && <Check data-icon="inline-start" />}
            {saving ? "Saving…" : saved ? "Saved" : "Save changes"}
          </Button>
        </div>
      </form>
    </PageSection>
  );
}

/** Who the bot speaks as (saved on pick, like a role play's persona) and the supporting skills it draws on. */
function BotPersonaAndSkills({ bot }: { bot: Bot }) {
  const refresh = useRefresh();
  const [persona, setPersona] = useState(bot.persona.slug);
  async function savePersona(slug: string) {
    const choice = bot.choices.personas.find((row) => row.slug === slug);
    if (!choice || slug === persona) return;
    const previous = persona;
    setPersona(slug);
    try {
      await twinClient.bots.update.mutate({ slug: bot.slug, personaId: choice.id });
      toast.success(`Now speaks as ${choice.name}`);
      refresh();
    } catch (error) {
      setPersona(previous);
      toast.error(error instanceof Error ? error.message : "Could not change the persona");
    }
  }
  return (
    <div className="flex flex-col gap-10">
      <PageSection title="Persona" label="Persona and skills" description="Who the bot speaks as: their name, photo, voice and manner. Yours or a custom persona.">
        <div className={cn(SECTION_CARD, "px-5 py-4")} aria-label="Speaks as" role="group">
          <PersonaPicker personas={pickerPersonas(bot.choices.personas)} value={persona} onChange={(slug) => void savePersona(slug)} />
        </div>
      </PageSection>
      <SupportingSkillsEditor
        title="Supporting skills"
        description="Published twin skills this bot may draw on, in order. Switch one off to keep it but leave it out of new calls."
        empty="No skills yet: the bot answers from its purpose only."
        attached={bot.skills}
        choices={bot.choices.skills}
        onSave={(skills) => twinClient.bots.update.mutate({ slug: bot.slug, skills })}
      />
    </div>
  );
}
