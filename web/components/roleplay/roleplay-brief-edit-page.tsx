"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Check, Play, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { PersonaPicker, TOOL_ROWS } from "@/components/roleplay/roleplay-builder-page";
import { PageContainer } from "@/components/page-container";
import { SettingCard, SettingsPanel, SettingsSection } from "@/components/settings-cards";
import { SwitchToggle } from "@/components/switch-toggle";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ToolSettings } from "@/lib/agent-tools";
import type { BeforeSettings } from "@/lib/context-upload";
import { seedCopilot } from "@/lib/copilot-handoff";
import { encodeCopilotMessage } from "@/lib/copilot-message";
import { roleplayClient } from "@/lib/roleplay/client";
import type { RoleplayOutputs } from "@/lib/roleplay/trpc";
import { useRefresh } from "@/lib/use-refresh";
import { cn } from "@/lib/utils";

type Brief = NonNullable<RoleplayOutputs["builder"]["get"]["brief"]>;
type Script = Brief["script"];
type Persona = RoleplayOutputs["builder"]["personas"][number];

const input = "w-full rounded-lg border border-(--border) bg-transparent px-3 text-sm text-(--foreground) outline-none focus:border-(--brand) focus:ring-1 focus:ring-(--brand)";
const card = "flex flex-col gap-5 rounded-tt-lg border border-(--card-border) bg-card p-6 shadow-card";
const kicker = "m-0 text-xs font-semibold tracking-wide text-muted-foreground uppercase";

function Field({ id, label, hint, children }: { id?: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className={kicker}>{label}</label>
      {children}
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

/** Opens the copilot on this role play, with the trainer's change request typed in. */
export function editWithCopilot(slug: string, title: string, change: string, go: (href: string) => void) {
  seedCopilot(encodeCopilotMessage({ skill: "roleplay-creator", files: [], text: `Change the role play "${title}" (${slug}): ${change}` }));
  go("/");
}

/** The script the copilot wrote, read-only: who plays whom, the situation, how it goes and how it ends. */
export function ScriptView({ script }: { script: Script }) {
  return (
    <div className="flex flex-col gap-6 text-sm leading-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <p className={kicker}>The AI plays</p>
          <p className="m-0 mt-1 font-medium">{script.aiRole}</p>
          <p className="m-0 mt-1 text-(--text-secondary)">{script.who}</p>
        </div>
        <div>
          <p className={kicker}>The learner plays</p>
          <p className="m-0 mt-1 font-medium">{script.learnerRole}</p>
          <p className="m-0 mt-1 text-(--text-secondary)">{script.learnerAim}</p>
        </div>
      </div>
      <div>
        <p className={kicker}>Situation</p>
        <ul className="m-0 mt-1 list-disc pl-5 text-(--text-secondary)">
          {script.situation.map((line) => <li key={line}>{line}</li>)}
        </ul>
      </div>
      {script.concerns.length ? (
        <div>
          <p className={kicker}>Concerns</p>
          <ul className="m-0 mt-1 list-disc pl-5 text-(--text-secondary)">
            {script.concerns.map((c) => (
              <li key={c.concern}>{c.concern}{c.hidden ? <span className="ml-1.5 rounded-full bg-(--tone-control) px-2 py-0.5 text-xs text-muted-foreground">hidden</span> : null}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <div>
        <p className={kicker}>How it goes</p>
        <ol className="m-0 mt-1 flex flex-col gap-2 pl-5">
          {script.steps.map((step) => (
            <li key={step.name}><span className="font-medium">{step.name}.</span> <span className="text-(--text-secondary)">{step.what}</span></li>
          ))}
        </ol>
      </div>
      <div>
        <p className={kicker}>How it ends</p>
        <p className="m-0 mt-1 text-(--text-secondary)">{[script.ending.limit, script.ending.good].filter(Boolean).join(" ")}</p>
      </div>
      {script.items ? <p className="m-0 text-xs text-muted-foreground">{script.items} example lines the AI can draw on during the call.</p> : null}
    </div>
  );
}

/**
 * Editing a role play the copilot wrote (lib/roleplay/brief.ts), kept as simple as the twin's edit page: General holds
 * the few things a trainer changes by hand; Script is read-only and changed by asking the copilot; Settings save as
 * they change.
 */
export function RoleplayBriefEditPage({ slug, brief, before: initialBefore, tools: initialTools, personas }: {
  slug: string;
  brief: Brief;
  before: BeforeSettings;
  tools: ToolSettings;
  personas: Persona[];
}) {
  const router = useRouter();
  const refresh = useRefresh();
  const [form, setForm] = useState({ persona: brief.persona, title: brief.title, learnerBrief: brief.learnerBrief, openingLine: brief.openingLine, limit: brief.limit });
  const [saving, setSaving] = useState(false);
  const [change, setChange] = useState("");
  const [before, setBefore] = useState(initialBefore);
  const [tools, setTools] = useState(initialTools);
  const saved = useRef({ before: initialBefore, tools: initialTools });
  const queue = useRef(Promise.resolve());
  const set = (key: keyof typeof form, value: string) => setForm((prev) => ({ ...prev, [key]: value }));
  const dirty = JSON.stringify(form) !== JSON.stringify({ persona: brief.persona, title: brief.title, learnerBrief: brief.learnerBrief, openingLine: brief.openingLine, limit: brief.limit });

  async function save() {
    setSaving(true);
    try {
      await roleplayClient.builder.saveBrief.mutate({ slug, ...form });
      toast.success("Role play saved");
      refresh();
      router.push(`/roleplay/${slug}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the role play");
    } finally {
      setSaving(false);
    }
  }

  function saveSettings(patch: { before?: BeforeSettings; tools?: ToolSettings }, done: string) {
    if (patch.before) setBefore(patch.before);
    if (patch.tools) setTools(patch.tools);
    queue.current = queue.current.then(async () => {
      try {
        await roleplayClient.builder.saveSettings.mutate({ slug, ...patch });
        saved.current = { ...saved.current, ...patch };
        toast.success(done);
        refresh();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not save");
        setBefore(saved.current.before);
        setTools(saved.current.tools);
      }
    });
  }

  return (
    <PageContainer>
      <header className="flex min-h-10 items-center justify-between gap-4">
        <Link href={`/roleplay/${slug}`} className="inline-flex items-center gap-2 text-sm text-(--foreground) transition-colors hover:text-muted-foreground">
          <ArrowLeft className="size-4" />
          <span>Back</span>
        </Link>
      </header>

      <div className="mt-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="m-0 text-title-m leading-7 font-semibold tracking-title">Edit role play</h1>
          <p className="mt-1 text-sm text-muted-foreground">Change the basics here. Ask the copilot to change the script.</p>
        </div>
        <Button variant="secondary" nativeButton={false} render={<Link href={`/talk?agent=${encodeURIComponent(slug)}`} />}>
          <Play data-icon="inline-start" /> Try it
        </Button>
      </div>

      <Tabs defaultValue="general" className="mt-6 gap-4">
        <TabsList>
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="script">Script</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="general">
          <article className={card}>
            <Field id="rp-title" label="Name">
              <input id="rp-title" maxLength={120} value={form.title} onChange={(e) => set("title", e.target.value)} className={cn(input, "h-10")} />
            </Field>
            <Field label="Persona" hint="Who the learner talks to: their name, photo, voice and manner.">
              <PersonaPicker personas={personas} value={form.persona} onChange={(slug) => set("persona", slug)} />
            </Field>
            <Field id="rp-brief" label="Learner brief" hint="Shown to the learner before the call: who they are, the situation and what to aim for.">
              <textarea id="rp-brief" rows={4} maxLength={1000} value={form.learnerBrief} onChange={(e) => set("learnerBrief", e.target.value)} className={cn(input, "py-2.5")} />
            </Field>
            <Field
              id="rp-opening"
              label={brief.aiStarts ? "Opening line" : "First reply"}
              hint={brief.aiStarts ? "The AI's first words when the call starts." : "The learner speaks first; this is the AI's first reply."}
            >
              <input id="rp-opening" maxLength={400} value={form.openingLine} onChange={(e) => set("openingLine", e.target.value)} className={cn(input, "h-10")} />
            </Field>
            <Field id="rp-limit" label="Time limit" hint={'Optional, e.g. "At most 5 minutes."'}>
              <input id="rp-limit" maxLength={200} value={form.limit} onChange={(e) => set("limit", e.target.value)} className={cn(input, "h-10")} />
            </Field>
          </article>
          <div className="flex items-center justify-end gap-3 pt-4">
            <Button variant="ghost" nativeButton={false} render={<Link href={`/roleplay/${slug}`} />}>Cancel</Button>
            <Button variant="brand" disabled={saving || !dirty || !form.title.trim() || !form.learnerBrief.trim() || (brief.aiStarts && !form.openingLine.trim())} onClick={() => void save()}>
              <Check data-icon="inline-start" /> {saving ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </TabsContent>

        <TabsContent value="script" className="flex flex-col gap-4">
          <form
            className={cn(card, "gap-3")}
            onSubmit={(event) => {
              event.preventDefault();
              if (change.trim()) editWithCopilot(slug, brief.title, change.trim(), router.push);
            }}
          >
            <label htmlFor="rp-change" className={kicker}>Change the script with the copilot</label>
            <textarea
              id="rp-change"
              rows={2}
              value={change}
              placeholder="e.g. Make the buyer push back harder on price, and end after 4 minutes."
              onChange={(e) => setChange(e.target.value)}
              className={cn(input, "py-2.5")}
            />
            <div className="flex justify-end">
              <Button type="submit" variant="brand" disabled={!change.trim()}>
                <Sparkles data-icon="inline-start" /> Ask the copilot
              </Button>
            </div>
          </form>
          <article className={card}>
            <ScriptView script={brief.script} />
          </article>
        </TabsContent>

        <TabsContent value="settings">
          <SettingsPanel>
            <SettingsSection title="Files" description="Changes save automatically.">
              <SettingCard
                title="Upload a file before the call"
                description="Learners may add a file before the call starts, like a résumé or a brochure. A PDF or an image, up to 10 MB."
                control={<SwitchToggle checked={before.preUpload} onChange={(on) => saveSettings({ before: { ...before, preUpload: on } }, `File upload before the call turned ${on ? "on" : "off"}`)} label="Upload a file before the call" />}
              />
              <SettingCard
                title="Attach during the call"
                description="Learners can share an image or a PDF while they talk."
                control={<SwitchToggle checked={before.duringUpload} onChange={(on) => saveSettings({ before: { ...before, duringUpload: on } }, `Attach during the call turned ${on ? "on" : "off"}`)} label="Attach files during the call" />}
              />
              <SettingCard
                title="Share screen"
                description="Learners share their entire screen for the whole call."
                control={<SwitchToggle checked={before.preScreenshare} onChange={(on) => saveSettings({ before: { ...before, preScreenshare: on } }, `Screen share turned ${on ? "on" : "off"}`)} label="Share screen" />}
              />
            </SettingsSection>
            <SettingsSection title="Workspace tools" description="What the AI can show on the learner's screen. All off unless you switch them on.">
              {TOOL_ROWS.map((row) => (
                <SettingCard
                  key={row.key}
                  title={row.label}
                  description={row.description}
                  control={<SwitchToggle checked={tools[row.key]} onChange={(on) => saveSettings({ tools: { ...tools, [row.key]: on } }, `${row.label} turned ${on ? "on" : "off"}`)} label={row.label} />}
                />
              ))}
            </SettingsSection>
          </SettingsPanel>
        </TabsContent>
      </Tabs>
    </PageContainer>
  );
}
