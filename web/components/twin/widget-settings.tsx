"use client";

import { useEffect, useState } from "react";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { SettingCard, SettingsPanel, SettingsSection } from "@/components/settings-cards";
import { SwitchToggle } from "@/components/switch-toggle";
import { twinClient } from "@/lib/twin/client";
import type { TwinOutputs } from "@/lib/twin/trpc";
import { useRefresh } from "@/lib/use-refresh";
import { widgetInstallSnippet, widgetSettingsSchema } from "@/lib/widget-settings";

type Twin = Pick<TwinOutputs["agents"]["get"], "slug" | "widget" | "publicAccess">;
const inputClass = "rounded-lg border border-(--border) bg-card p-3 text-sm outline-none focus:border-(--brand) focus:ring-1 focus:ring-(--brand)";

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
    <SettingsPanel>
      <SettingsSection title="Website widget" description="Add voice-only conversations to your website. Both Public access and the widget must be enabled before visitors can call. Public call duration and organization-funded limits apply.">
        {!twin.publicAccess.enabled ? <p className="text-sm text-muted-foreground" role="status">Public access is off. Enable it in the Public access tab separately; saving here does not change it.</p> : null}
        <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <fieldset disabled={saving} className="flex min-w-0 flex-col gap-4">
            <SettingCard title="Enable widget" description="Only websites with an exact origin listed below may embed this twin."
              control={<SwitchToggle checked={draft.enabled} onChange={(enabled) => setDraft({ ...draft, enabled })} label="Enable website widget" />} />
            <SettingCard title="Allowed website origins" description="One origin per line, up to 20. Include HTTPS and any non-default port. No paths, trailing slashes, wildcards, queries or credentials. HTTP is only for localhost development." control={null}>
              <label htmlFor="widget-origins" className="sr-only">Allowed website origins</label>
              <textarea id="widget-origins" rows={4} value={origins} onChange={(event) => setOrigins(event.target.value)} placeholder={"https://example.com\nhttps://www.example.com"} className={inputClass} />
            </SettingCard>
            <SettingCard title="Appearance" description="Visitors enter their name and explicitly start a voice call. This preview does not open a call or grant the studio permission to embed." control={null}>
              <div className="flex flex-col gap-4">
                <label htmlFor="widget-welcome" className="flex flex-col gap-2 text-sm">Welcome message
                  <input id="widget-welcome" value={draft.welcome} maxLength={120} onChange={(event) => setDraft({ ...draft, welcome: event.target.value })} className={inputClass} />
                </label>
                <label htmlFor="widget-colour" className="flex flex-col gap-2 text-sm">Accent colour
                  <input id="widget-colour" value={draft.accentColor} maxLength={7} onChange={(event) => setDraft({ ...draft, accentColor: event.target.value })} placeholder="#111111" className={inputClass} />
                </label>
                <div className="rounded-lg border p-4">
                  <p className="text-xs text-muted-foreground">Text preview</p>
                  <p className="mt-2 text-sm font-medium">{draft.welcome}</p>
                  <svg className="mt-2 h-1 w-16" aria-hidden="true" viewBox="0 0 64 4">
                    <rect width="64" height="4" rx="2" fill={/^#[0-9a-f]{6}$/i.test(draft.accentColor) ? draft.accentColor : "#111111"} />
                  </svg>
                </div>
              </div>
            </SettingCard>
            <div className="flex items-center justify-end gap-2">
              {dirty ? <span className="mr-auto text-xs text-muted-foreground">Unsaved changes</span> : null}
              <Button type="button" variant="ghost" disabled={!dirty} onClick={() => { setDraft(saved); setOrigins(saved.allowedOrigins.join("\n")); }}>Cancel</Button>
              <Button type="submit" disabled={!dirty}>Save</Button>
            </div>
          </fieldset>
        </form>
      </SettingsSection>
      <SettingsSection title="Install" description="Paste the snippet into an allowed website. It contains only your public embed ID, not credentials. Your website must permit loading this script and iframe, and delegate microphone access if it is itself embedded.">
        <SettingCard title="Embed ID" description="This twin’s stable public identifier." control={<Button variant="secondary" onClick={() => void copy(twin.widget.id)}><Copy data-icon="inline-start" />Copy ID</Button>}>
          <code className="break-all text-sm">{twin.widget.id}</code>
        </SettingCard>
        {(["floating", "inline"] as const).map((mode) => {
          const snippet = widgetInstallSnippet(twin.widget.origin, twin.widget.id, mode);
          return (
            <SettingCard key={mode} title={mode === "floating" ? "Floating launcher" : "Inline panel"}
              description={mode === "floating" ? "Place once before your page’s closing body tag." : "Place the script where the panel should appear. It mounts next to the script."}
              control={<Button variant="secondary" onClick={() => void copy(snippet)}><Copy data-icon="inline-start" />Copy snippet</Button>}>
              <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg border p-4 text-xs"><code>{snippet}</code></pre>
            </SettingCard>
          );
        })}
      </SettingsSection>
    </SettingsPanel>
  );
}
