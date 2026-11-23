"use client";

import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { PageSection, SECTION_CARD, SectionRow } from "@/components/page-section";
import { SwitchToggle } from "@/components/switch-toggle";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { twinClient } from "@/lib/twin/client";
import type { TwinOutputs } from "@/lib/twin/trpc";
import { useRefresh } from "@/lib/use-refresh";
import { PUBLIC_CALL_DURATIONS, type PublicTwinSettings } from "@/lib/public-twin-settings";
import { widgetInstallSnippet, widgetSettingsSchema, type WidgetSettings } from "@/lib/widget-settings";
import { cn } from "@/lib/utils";

type Bot = TwinOutputs["bots"]["get"];
/** The allowed websites as typed, one per line. Welcome text and accent colour keep their saved values (not editable yet). */
const draftOf = (config: WidgetSettings) => config.allowedOrigins.join("\n");

/**
 * One bot's website channel: public calls (on/off, length) and the widget (allowed websites, install code). Save rule: the switch and the duration select save as soon as they
 * change; the allowed websites are a draft, saved from the bar that appears under them while they differ. The widget has
 * no switch of its own: it is live while anonymous visitors are allowed and at least one website is saved.
 */
export function PublicAccessPanel({ bot }: { bot: Bot }) {
  const refresh = useRefresh();
  const [access, setAccess] = useState(bot.publicAccess);
  const [widget, setWidget] = useState(bot.widget.config);
  const [draft, setDraft] = useState(() => draftOf(bot.widget.config));
  const [busy, setBusy] = useState<"access" | "websites" | null>(null);
  const dirty = draft !== draftOf(widget);

  // Follow fresh server data (e.g. after a refresh) without discarding unsaved typing.
  const [received, setReceived] = useState(bot);
  if (received !== bot) {
    setReceived(bot);
    setAccess(bot.publicAccess);
    setWidget(bot.widget.config);
    if (!dirty) setDraft(draftOf(bot.widget.config));
  }

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  async function saveAccess(patch: Partial<PublicTwinSettings>, done: string) {
    const previous = access;
    setAccess({ ...access, ...patch });
    setBusy("access");
    try {
      await twinClient.bots.update.mutate({ slug: bot.slug, publicAccess: patch });
      toast.success(done);
      refresh();
    } catch (error) {
      setAccess(previous);
      toast.error(error instanceof Error ? error.message : "Could not save public access");
    } finally {
      setBusy(null);
    }
  }

  async function saveWebsites() {
    const allowedOrigins = draft.split("\n").map((origin) => origin.trim()).filter(Boolean);
    // Same rule as the server (lib/bots): the widget is on exactly when it lists a website.
    const parsed = widgetSettingsSchema.safeParse({ ...widget, allowedOrigins, enabled: allowedOrigins.length > 0 });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0].message);
      return;
    }
    setBusy("websites");
    try {
      await twinClient.bots.update.mutate({ slug: bot.slug, widget: { allowedOrigins: parsed.data.allowedOrigins } });
      setWidget(parsed.data);
      setDraft(draftOf(parsed.data));
      toast.success("Allowed websites saved");
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save allowed websites");
    } finally {
      setBusy(null);
    }
  }

  const widgetLocked = !access.enabled;
  const websites = widget.allowedOrigins.length;
  const live = access.enabled && websites > 0;

  return (
    <div className="flex min-w-0 flex-col gap-10">
      <PageSection title="Public voice calls"
        description="Let signed-out visitors talk to this bot. Calls are paid from your organization’s balance, not learner credits. Changes save automatically.">
        <div className={SECTION_CARD}>
          <SectionRow title="Allow anonymous visitors" detail="Anyone on an allowed website (and, for a twin’s first bot, anyone with the twin’s link) can start a short voice call.">
            <SwitchToggle checked={access.enabled} label="Allow anonymous visitors"
              onChange={(enabled) => { if (!busy) void saveAccess({ enabled }, enabled ? "Anonymous visitors allowed" : "Anonymous visitors turned off"); }} />
          </SectionRow>
          <SectionRow title={<label htmlFor="public-call-duration">Maximum call duration</label>} detail="Each public call ends automatically at this limit.">
            <NativeSelect id="public-call-duration" value={access.maxSeconds} disabled={busy !== null}
              onChange={(event) => {
                const seconds = PUBLIC_CALL_DURATIONS.find((value) => String(value) === event.target.value);
                if (seconds && seconds !== access.maxSeconds) void saveAccess({ maxSeconds: seconds }, `Calls now end after ${seconds / 60} min`);
              }}>
              {PUBLIC_CALL_DURATIONS.map((seconds) => <option key={seconds} value={seconds}>{seconds / 60} min</option>)}
            </NativeSelect>
          </SectionRow>
        </div>
      </PageSection>

      <PageSection title="Website widget" description="Show this bot as a voice widget on your own website.">
        <div className={cn(SECTION_CARD, "min-w-0 overflow-hidden")}>
          {!live ? (
            <p role="status" className="m-0 flex items-center gap-2 border-b border-(--border) px-5 py-3 text-sm text-muted-foreground">
              <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-(--tone-control)" />
              {widgetLocked ? <span>Off. Turn on <span className="font-medium text-foreground">Allow anonymous visitors</span> to use the widget.</span>
                : <span>Off. Add a website below to show the widget.</span>}
            </p>
          ) : null}
          <form className="min-w-0" onSubmit={(event) => { event.preventDefault(); if (dirty) void saveWebsites(); }}>
            <fieldset disabled={widgetLocked || busy === "websites"} className={cn("m-0 min-w-0 transition-opacity", widgetLocked && "opacity-50")}>
              <div className="flex flex-col gap-2 px-5 py-4">
                <label htmlFor="widget-origins" className="text-sm font-medium">Allowed websites</label>
                <Textarea id="widget-origins" rows={3} value={draft} onChange={(event) => setDraft(event.target.value)}
                  placeholder={"https://example.com\nhttps://www.example.com"} aria-describedby="widget-origins-help" className="min-h-20 resize-y font-mono text-sm" />
                <p id="widget-origins-help" className="m-0 text-xs text-muted-foreground">
                  One per line, up to 20 — scheme and host only, e.g. https://example.com. Remove a website to take the widget off it.
                </p>
              </div>
            </fieldset>
            {dirty ? (
              <div className="flex items-center justify-end gap-2 border-t border-(--border) bg-muted/30 px-5 py-3">
                <span className="mr-auto text-sm text-muted-foreground" role="status">Unsaved changes</span>
                <Button type="button" variant="ghost" disabled={busy === "websites"} onClick={() => setDraft(draftOf(widget))}>Discard</Button>
                <Button type="submit" disabled={busy === "websites"}>{busy === "websites" ? "Saving…" : "Save"}</Button>
              </div>
            ) : null}
          </form>
          <InstallSection origin={bot.widget.origin} id={bot.widget.id} live={live} />
        </div>
        <p className="m-0 text-xs text-muted-foreground">If your website sets a Content Security Policy, allow this script and its frame, and delegate microphone access.</p>
      </PageSection>
    </div>
  );
}

function InstallSection({ origin, id, live }: { origin: string; id: string; live: boolean }) {
  const [copied, setCopied] = useState(false);
  const snippet = widgetInstallSnippet(origin, id);
  const displaySnippet = snippet
    .replace(" src=", "\n  src=")
    .replace(" data-twin-id=", "\n  data-twin-id=")
    .replace(" data-mode=", "\n  data-mode=")
    .replace(" referrerpolicy=", "\n  referrerpolicy=")
    .replace(" defer>", "\n  defer\n>");

  async function copy() {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Could not copy. Select and copy the code below.");
    }
  }

  return (
    <section aria-label="Install" className="flex min-w-0 flex-col gap-3 border-t border-(--border) px-5 py-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        <div className="min-w-0">
          <div className="text-sm font-medium">Install code</div>
          <div className="mt-0.5 text-sm text-muted-foreground">
            {live ? "Paste this once before your page’s closing </body> tag. It contains no credentials."
              : "Paste this once before your page’s closing </body> tag. The widget appears after it’s turned on above."}
          </div>
        </div>
        <Button type="button" variant="outline" size="lg" onClick={() => void copy()}>
          {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}{copied ? "Copied" : "Copy code"}
        </Button>
      </div>
      <pre className="m-0 min-w-0 whitespace-pre-wrap break-all rounded-tt-md border border-(--border) bg-muted/40 p-4 text-xs leading-6"><code>{displaySnippet}</code></pre>
    </section>
  );
}

