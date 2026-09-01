"use client";

import { useState } from "react";
import { Check, Copy, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

type ApiKeyRecord = {
  id: string;
  name: string | null;
  start: string | null;
  enabled: boolean | null;
  expiresAt: string | null;
  lastRequest: string | null;
  createdAt: string;
};

export function ApiKeyManager({ initialKeys }: { initialKeys: ApiKeyRecord[] }) {
  const [keys, setKeys] = useState(initialKeys);
  const [name, setName] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  async function createKey(event: React.FormEvent) {
    event.preventDefault();
    setCreating(true);
    setError(null);
    const response = await fetch("/api/developer/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const result = await response.json().catch(() => null);
    setCreating(false);
    if (!response.ok) {
      setError(result?.error || "Could not create API key");
      return;
    }
    setKeys((current) => [result.record, ...current]);
    setName("");
    setSecret(result.key);
    setCopied(false);
  }

  async function copySecret() {
    if (!secret) return;
    await navigator.clipboard.writeText(secret);
    setCopied(true);
    toast.success("API key copied");
  }

  async function revokeKey(id: string) {
    if (!window.confirm("Revoke this API key? Integrations using it will stop immediately.")) return;
    setRevoking(id);
    const response = await fetch("/api/developer/api-keys", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
    setRevoking(null);
    if (!response.ok) return toast.error("Could not revoke API key");
    setKeys((current) => current.filter((key) => key.id !== id));
    toast.success("API key revoked");
  }

  return (
    <Card className="mt-3">
      <CardContent className="space-y-5">
        <form onSubmit={createKey} className="flex flex-col gap-5">
          <FieldGroup>
            <Field data-invalid={Boolean(error)}>
              <FieldLabel htmlFor="api-key-name">Key name</FieldLabel>
              <Input
                id="api-key-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Learning platform production"
                maxLength={60}
                aria-invalid={Boolean(error)}
                required
              />
              <FieldDescription>Use a name that identifies the platform or environment.</FieldDescription>
              <FieldError>{error}</FieldError>
            </Field>
          </FieldGroup>
          <div>
            <Button type="submit" disabled={creating || !name.trim()}>
              {creating ? "Generating…" : "Generate key"}
            </Button>
          </div>
        </form>

        {secret && (
          <div
            role="status"
            className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100"
          >
            <p className="text-sm font-semibold">Copy this key now. It will not be shown again.</p>
            <div className="mt-3 flex items-start gap-2">
              <code className="min-w-0 flex-1 break-all rounded bg-background/80 px-3 py-2 text-xs">{secret}</code>
              <Button type="button" size="icon" variant="outline" onClick={copySecret} aria-label="Copy API key">
                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              </Button>
            </div>
          </div>
        )}

        <div className="border-t pt-5">
          <p className="text-sm font-medium">API keys</p>
          {keys.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">No API keys yet.</p>
          ) : (
            <div className="mt-2 divide-y border-y">
              {keys.map((key) => (
                <div key={key.id} className="flex items-center justify-between gap-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{key.name || "Unnamed key"}</p>
                    <p className="mt-1 font-mono text-xs text-muted-foreground">{key.start || "tt_••••••"}…</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Expires {key.expiresAt ? new Date(key.expiresAt).toLocaleDateString() : "never"}
                      {key.lastRequest ? ` · Last used ${new Date(key.lastRequest).toLocaleDateString()}` : " · Never used"}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="shrink-0 text-muted-foreground hover:text-destructive"
                    onClick={() => revokeKey(key.id)}
                    disabled={revoking === key.id}
                    aria-label={`Revoke ${key.name || "API key"}`}
                  >
                    {revoking === key.id ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
        <FieldDescription>
          Send the key as <code className="rounded bg-muted px-1 py-0.5">x-api-key</code>. Keys expire after one year and are limited to 120 requests per minute.
        </FieldDescription>
      </CardContent>
    </Card>
  );
}
