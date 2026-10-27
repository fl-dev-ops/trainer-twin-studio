"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowLeft, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { AssignDialog, type AssignPerson } from "@/components/assign-dialog";
import { Button } from "@/components/ui/button";
import { UserAvatar } from "@/components/user-avatar";
import type { RoleplayOutputs } from "@/lib/roleplay/trpc";
import { cn } from "@/lib/utils";

type Detail = RoleplayOutputs["scenarios"]["get"];

const STATUS: Record<string, string> = { pending: "Invited", used: "Practised", expired: "Expired", cancelled: "Cancelled" };

/**
 * Assign a role play: its members and their invite status, and Assign, which opens the shared assign dialog
 * (role-play variant). Invites go through the existing role-play invite route (one attempt, 30 days, org lock).
 */
export function RoleplayAssignPage({ roleplay, learners }: { roleplay: Detail; learners: AssignPerson[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // Invited and not expired, or already practised: not offered again. Expired or cancelled invites can be re-sent.
  const active = new Set(roleplay.members.filter((m) => m.status === "pending" || m.status === "used").map((m) => m.email.toLowerCase()));
  const assignable = learners.filter((person) => !active.has(person.email.toLowerCase()));

  async function assign(emails: string[]) {
    try {
      const res = await fetch(`/api/role-play/${encodeURIComponent(roleplay.slug)}/assignments`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emails, resendPending: "ignore" }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Could not assign");
      const parts = [body.added ? `${body.added} invited` : "", body.resent ? `${body.resent} re-sent` : "", body.skipped ? `${body.skipped} already invited` : ""].filter(Boolean);
      toast.success(parts.join(" · ") || "Done");
      if (body.blocked) toast.warning(`${body.blocked} learner(s) belong to another organization and were not invited.`);
      if (body.emailFailures) toast.warning(`${body.emailFailures} invite email(s) could not be sent.`);
      router.refresh();
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not assign");
      return false;
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
        <div className="mt-6 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="m-0 text-[20px] leading-7 font-semibold tracking-[-0.015em]">Assign roleplay</h1>
            <p className="mt-1 text-sm text-muted-foreground">{roleplay.name} · {roleplay.members.length} assigned</p>
          </div>
          <Button onClick={() => setOpen(true)} className="bg-(--brand) text-white hover:bg-[#e04d00]">
            <UserPlus data-icon="inline-start" /> Assign learners
          </Button>
        </div>

        <article className="mt-6 rounded-[16px] border border-(--card-border) bg-card p-2 shadow-[0_2px_4px_rgb(30_28_25/0.035),0_8px_20px_rgb(30_28_25/0.055)]">
          {roleplay.members.length ? (
            <ul className="m-0 flex list-none flex-col p-0">
              {roleplay.members.map((member, i) => (
                <li key={member.id} className={cn("flex items-center justify-between gap-3 px-4 py-3", i > 0 && "border-t border-(--border)")}>
                  <span className="flex min-w-0 items-center gap-3">
                    <UserAvatar user={{ name: member.name, image: member.image }} className="size-8 text-xs" />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-sm font-medium">{member.name}</span>
                      <span className="truncate text-xs text-muted-foreground">{member.email}</span>
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">{STATUS[member.status] ?? member.status}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="m-0 p-6 text-center text-sm text-muted-foreground">Nobody is assigned yet.</p>
          )}
        </article>

        <AssignDialog
          variant="roleplay"
          open={open}
          onOpenChange={setOpen}
          title={roleplay.name}
          assignedCount={active.size}
          people={assignable}
          onAssign={(emails) => assign(emails)}
        />
      </div>
    </div>
  );
}
