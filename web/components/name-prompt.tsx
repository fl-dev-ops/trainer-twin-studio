"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";
import { isPlaceholderName } from "@/lib/user-name";

const SKIPPED_KEY = "tt:name-prompt-skipped";

function skipped(userId: string) {
  try {
    return window.localStorage.getItem(SKIPPED_KEY) === userId;
  } catch {
    return false;
  }
}

/**
 * Asks once for the person's name while it is still the placeholder made from their email (lib/user-name.ts): people
 * added by email who sign in with a code have no other source for it. Google sign-ins fill it in on the server.
 */
export function NamePrompt() {
  const { data, refetch } = authClient.useSession();
  const user = data?.user;
  const [dismissed, setDismissed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!user || dismissed || !isPlaceholderName(user.name, user.email) || skipped(user.id)) return null;

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get("name") ?? "").trim();
    if (!name) {
      setError("Enter your name.");
      return;
    }
    setSaving(true);
    setError(null);
    const result = await authClient.updateUser({ name });
    setSaving(false);
    if (result.error) {
      setError(result.error.message ?? "Could not save your name.");
      return;
    }
    setDismissed(true);
    refetch();
  }

  function later() {
    try {
      window.localStorage.setItem(SKIPPED_KEY, user!.id);
    } catch {
      // Private mode: it simply asks again next time.
    }
    setDismissed(true);
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) later(); }}>
      <DialogContent className="sm:max-w-[420px]">
        <form onSubmit={save} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>What should we call you?</DialogTitle>
            <DialogDescription>Your name, as your trainer and team see it.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Input name="name" autoComplete="name" autoFocus placeholder="Your full name" aria-invalid={Boolean(error)} maxLength={120} />
            {error ? <p role="alert" className="m-0 text-xs text-destructive">{error}</p> : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={later}>Later</Button>
            <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
