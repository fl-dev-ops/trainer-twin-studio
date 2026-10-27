"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowLeft, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { UserAvatar } from "@/components/user-avatar";
import type { RoleplayOutputs } from "@/lib/roleplay/trpc";
import { cn } from "@/lib/utils";

type Detail = RoleplayOutputs["scenarios"]["get"];

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Assign a role play (reference "Assign roleplay"): email invites through the existing role-play invite route
 * (one attempt, 30 days, org lock), then the members and their status.
 */
export function RoleplayAssignPage({ roleplay }: { roleplay: Detail }) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  const emails = [...new Set(value.split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean))];
  const invalid = emails.filter((email) => !EMAIL.test(email));

  async function assign() {
    if (!emails.length || invalid.length) return;
    setSending(true);
    try {
      const res = await fetch(`/api/role-play/${encodeURIComponent(roleplay.slug)}/assignments`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emails }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Could not assign");
      const parts = [
        body.added ? `${body.added} invited` : "",
        body.resent ? `${body.resent} re-sent` : "",
        body.skipped ? `${body.skipped} already invited` : "",
      ].filter(Boolean);
      toast.success(parts.join(" · ") || "Done");
      if (body.blocked) toast.warning(`${body.blocked} learner(s) belong to another organization and were not invited.`);
      if (body.emailFailures) toast.warning(`${body.emailFailures} invite email(s) could not be sent.`);
      setValue("");
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not assign");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[760px] px-4 pt-5 pb-16 md:px-0">
        <header className="flex min-h-10 items-center">
          <Link href={`/roleplay/${roleplay.slug}`} className="inline-flex items-center gap-2 text-sm text-(--foreground) transition-colors hover:text-muted-foreground">
            <ArrowLeft className="size-4" />
            <span>Back</span>
          </Link>
        </header>
        <div className="mt-6">
          <h1 className="m-0 text-[20px] leading-7 font-semibold tracking-[-0.015em]">Assign roleplay</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {roleplay.name}. Each person gets an email with their own link: one attempt, valid for 30 days.
          </p>
        </div>

        <article className="mt-6 flex flex-col gap-3 rounded-[16px] border border-(--card-border) bg-card p-6 shadow-[0_2px_4px_rgb(30_28_25/0.035),0_8px_20px_rgb(30_28_25/0.055)]">
          <label htmlFor="assign-emails" className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Emails
          </label>
          <textarea
            id="assign-emails"
            rows={3}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="name@company.com, another@company.com"
            className="rounded-lg border border-(--border) bg-transparent p-3 text-sm outline-none focus:border-(--brand) focus:ring-1 focus:ring-(--brand)"
          />
          <div className="flex items-center justify-between gap-3">
            <span className={cn("text-xs", invalid.length ? "text-destructive" : "text-muted-foreground")}>
              {invalid.length ? `Not an email: ${invalid.slice(0, 3).join(", ")}` : `${emails.length} ${emails.length === 1 ? "person" : "people"}`}
            </span>
            <button
              type="button"
              disabled={sending || !emails.length || invalid.length > 0}
              onClick={() => void assign()}
              className="inline-flex h-9 items-center gap-2 rounded-full bg-(--brand) px-4 text-sm font-medium text-white transition-colors hover:bg-[#e04d00] disabled:opacity-60"
            >
              <UserPlus className="size-4" />
              {sending ? "Sending…" : "Assign"}
            </button>
          </div>
        </article>

        <h2 className="mt-8 text-[17px] font-semibold tracking-[-0.015em]">Members</h2>
        {roleplay.members.length ? (
          <ul className="m-0 mt-2 flex list-none flex-col p-0">
            {roleplay.members.map((member, i) => (
              <li key={member.id} className={cn("flex items-center justify-between gap-3 py-3", i > 0 && "border-t border-(--border)")}>
                <span className="flex min-w-0 items-center gap-3">
                  <UserAvatar user={{ name: member.name, image: member.image }} className="size-8 text-xs" />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-sm font-medium">{member.name}</span>
                    <span className="truncate text-xs text-muted-foreground">{member.email}</span>
                  </span>
                </span>
                <span className="shrink-0 text-xs text-muted-foreground capitalize">{member.status === "used" ? "practised" : member.status === "pending" ? "invited" : member.status}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">Nobody is assigned yet.</p>
        )}
      </div>
    </div>
  );
}
