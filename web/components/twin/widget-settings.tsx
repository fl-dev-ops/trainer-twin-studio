"use client";

import { useEffect, useState } from "react";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { PageSection, SECTION_CARD, SectionRow } from "@/components/page-section";
import { SwitchToggle } from "@/components/switch-toggle";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { twinClient } from "@/lib/twin/client";
import type { TwinOutputs } from "@/lib/twin/trpc";
import { useRefresh } from "@/lib/use-refresh";
import { widgetInstallSnippet, widgetSettingsSchema } from "@/lib/widget-settings";
import { cn } from "@/lib/utils";

type Twin = Pick<TwinOutputs["agents"]["get"], "slug" | "widget" | "publicAccess">;

export function WidgetSettingsPanel({ twin }: { twin: Twin }) {
  const refresh = useRefresh();
  const [saved, setSaved] = useState(twin.widget.config);
  const [draft, setDraft] = useState(twin.widget.config);
  const [origins, setOrigins] = useState(twin.widget.config.allowedOrigins.join("\n"));
  const [saving, setSaving] = useState(false);
  const [received, setReceived] = useState(twin.widget.config);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved) || origins !== saved.allowedOrigins.join("\n");

  if (JSON.stringify(received) !== JSON.stringify(twin.widget.config)) {
    setReceived(twin.widget.config);
    setSaved(twin.widget.config);
    if (!dirty) {
      setDraft(twin.widget.config);
      setOrigins(twin.widget.config.allowedOrigins.join("\n"));
    }
  }

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  async function save() {
    const parsed = widgetSettingsSchema.safeParse({ ...draft, allowedOrigins: origins.split("\n").map((origin) => origin.trim()).filter(Boolean) });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0].message);
      return;
    }
    setSaving(true);
    try {
      await twinClient.agents.update.mutate({ slug: twin.slug, widget: parsed.data });
      setSaved(parsed.data);
      setDraft(parsed.data);
      setOrigins(parsed.data.allowedOrigins.join("\n"));
      toast.success("Widget settings saved");
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save widget settings");
    } finally {
      setSaving(false);
    }
  }

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success("Copied");
    } catch {
      toast.error("Could not copy. Select and copy the code below.");
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-10 pt-8">
      <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <fieldset disabled={saving} className="flex min-w-0 flex-col gap-10">
          <PageSection title="Website widget" description="Add voice conversations to your website. Public call duration and organization-funded limits apply.">
            {!twin.publicAccess.enabled ? <p className="m-0 text-sm text-muted-foreground" role="status">Public access is off. Enable it in the Public access tab before visitors can call.</p> : null}
            <div className={SECTION_CARD}>
              <SectionRow title="Enable widget" detail="Allow this twin on the websites below. Changes apply when you save.">
                <SwitchToggle checked={draft.enabled} onChange={(enabled) => setDraft({ ...draft, enabled })} label="Enable website widget" />
              </SectionRow>
              <SectionRow title={<label htmlFor="widget-origins">Allowed website origins</label>} detail="One exact origin per line, up to 20. Include HTTPS and any non-default port; no paths, trailing slashes or wildcards.">
                <div className="w-full sm:w-80">
                  <Textarea id="widget-origins" rows={4} value={origins} onChange={(event) => setOrigins(event.target.value)}
                    placeholder={"https://example.com\nhttps://www.example.com"} aria-describedby="widget-origins-help" className="min-h-24 resize-y text-sm" />
                  <p id="widget-origins-help" className="m-0 mt-2 text-xs text-muted-foreground">HTTP is supported only for localhost development.</p>
                </div>
              </SectionRow>
            </div>
          </PageSection>
          <PageSection title="Appearance" description="The welcome message and accent visitors see before starting a call.">
            <div className={SECTION_CARD}>
              <SectionRow title={<label htmlFor="widget-welcome">Welcome message</label>} detail="Up to 120 characters.">
                <div className="w-full sm:w-80">
                  <Input id="widget-welcome" value={draft.welcome} maxLength={120} onChange={(event) => setDraft({ ...draft, welcome: event.target.value })} />
                </div>
              </SectionRow>
              <SectionRow title={<label htmlFor="widget-colour">Accent colour</label>} detail="A six-digit hex colour.">
                <svg className="size-8 shrink-0 rounded-lg border border-(--border)" aria-hidden="true" viewBox="0 0 32 32">
                  <rect width="32" height="32" fill={/^#[0-9a-f]{6}$/i.test(draft.accentColor) ? draft.accentColor : "#111111"} />
                </svg>
                <Input id="widget-colour" value={draft.accentColor} maxLength={7} onChange={(event) => setDraft({ ...draft, accentColor: event.target.value })}
                  placeholder="#111111" className="w-32 font-mono" />
              </SectionRow>
              <SectionRow title="Text preview" detail="No call is opened or microphone requested.">
                <p className="m-0 max-w-80 break-words text-sm font-medium">{draft.welcome}</p>
              </SectionRow>
            </div>
          </PageSection>
        </fieldset>
        <div className="flex items-center justify-end gap-3">
          {dirty ? <span className="mr-auto text-sm text-muted-foreground" role="status">Unsaved changes</span> : null}
          <Button type="button" variant="ghost" disabled={saving || !dirty} onClick={() => { setDraft(saved); setOrigins(saved.allowedOrigins.join("\n")); }}>Cancel</Button>
          <Button type="submit" disabled={saving || !dirty}>{saving ? "Saving…" : "Save"}</Button>
        </div>
      </form>
      <PageSection title="Install" description="Add one snippet to an allowed website. The embed ID is public; no credentials are included.">
        <div className={cn(SECTION_CARD, "min-w-0 overflow-hidden")}>
          <SectionRow title="Embed ID" detail="This twin’s stable public identifier.">
            <code className="break-all text-xs">{twin.widget.id}</code>
            <Button variant="outline" size="sm" onClick={() => void copy(twin.widget.id)}><Copy data-icon="inline-start" />Copy ID</Button>
          </SectionRow>
          {(["floating", "inline"] as const).map((mode) => {
            const snippet = widgetInstallSnippet(twin.widget.origin, twin.widget.id, mode);
            return (
              <section key={mode} aria-label={mode === "floating" ? "Floating launcher" : "Inline panel"} className="border-t border-(--border)">
                <SectionRow title={mode === "floating" ? "Floating launcher" : "Inline panel"}
                  detail={mode === "floating" ? "Place once before your page’s closing body tag." : "Place the script where the panel should appear."}>
                  <Button variant="outline" size="sm" onClick={() => void copy(snippet)}><Copy data-icon="inline-start" />Copy snippet</Button>
                </SectionRow>
                <pre className="m-0 overflow-x-auto border-t border-(--border) bg-muted/30 px-5 py-4 text-xs leading-6"><code>{snippet}</code></pre>
              </section>
            );
          })}
        </div>
        <p className="m-0 text-xs text-muted-foreground">Your website must allow the script and iframe, and delegate microphone access if it is itself embedded.</p>
      </PageSection>
    </div>
  );
}
