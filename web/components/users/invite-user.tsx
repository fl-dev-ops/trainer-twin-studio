"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { authClient } from "@/lib/auth-client";
import { BASE_DOMAIN } from "@/lib/base-domain";
import { CopyButton } from "@/components/users/copy-button";

/** Invites someone by email as team (runs the studio) or user (practises); no second admin. Shows the signup link too. */
export function InviteUser({ organizationId }: { organizationId: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"user" | "team">("user");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setInviteUrl(null);
    const invited = await authClient.organization.inviteMember({
      email: email.trim(),
      role,
      organizationId,
    });
    setBusy(false);
    if (invited.error) {
      setError(invited.error.message ?? "Could not create the invite");
      return;
    }
    setEmail("");
    setInviteUrl(`https://auth.${BASE_DOMAIN}/invite?token=${invited.data.id}`);
    toast.success("Invitation email sent");
    router.refresh();
  }

  return (
    <div className="grid gap-2">
      <form onSubmit={onSubmit} className="flex gap-2">
        <Input
          type="email"
          placeholder="user@email.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          className="max-w-xs"
        />
        <NativeSelect aria-label="Role" value={role} onChange={(e) => setRole(e.target.value as "user" | "team")}>
          <NativeSelectOption value="user">User</NativeSelectOption>
          <NativeSelectOption value="team">Team</NativeSelectOption>
        </NativeSelect>
        <Button type="submit" disabled={busy}>
          {busy ? "Inviting…" : "Invite"}
        </Button>
      </form>
      {error ? <p className="text-destructive text-sm">{error}</p> : null}
      {inviteUrl ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted p-3 text-sm">
          <code className="truncate text-xs select-all">{inviteUrl}</code>
          <CopyButton value={inviteUrl} />
        </div>
      ) : null}
    </div>
  );
}
