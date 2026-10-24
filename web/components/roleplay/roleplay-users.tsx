import { Users } from "lucide-react";
import { LearnerAvatar } from "@/components/roleplay/learner-avatar";
import { RoleplayPageHead } from "@/components/roleplay/page-head";
import type { RoleplayUserRow } from "@/lib/roleplay-sessions";

/** Roleplay users: everyone practising on the org's role plays. */
export function RoleplayUsers({ rows }: { rows: RoleplayUserRow[] }) {
  return (
    <main className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[896px] px-4 pt-7 pb-12">
        <RoleplayPageHead icon={<Users />} title="Roleplay users" section="All users" note="People practising on your roleplays" />
        <div className="overflow-x-auto rounded-2xl border bg-card shadow-xs">
          <table className="w-full min-w-[40rem] text-sm">
            <thead>
              <tr className="bg-muted/60 text-left text-xs font-medium tracking-[0.06em] text-muted-foreground uppercase">
                <th className="px-5 py-2.5 font-medium">Name</th>
                <th className="px-5 py-2.5 font-medium">Email</th>
                <th className="px-5 py-2.5 font-medium">Roleplay assigned</th>
                <th className="px-5 py-2.5 font-medium">Sessions</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan={4} className="px-5 py-10 text-center text-muted-foreground">No one is practising yet. Assign a role play to invite learners.</td></tr>
              ) : rows.map((row, index) => (
                <tr key={row.email} className="border-t">
                  <td className="px-5 py-4">
                    <span className="flex items-center gap-3">
                      <LearnerAvatar name={row.name} index={index} className="size-7 text-xs" />
                      {row.name}
                    </span>
                  </td>
                  <td className="px-5 py-4 text-muted-foreground">{row.email}</td>
                  <td className="px-5 py-4 tabular-nums">{row.roleplays} <span className="text-muted-foreground">{row.roleplays === 1 ? "roleplay" : "roleplays"}</span></td>
                  <td className="px-5 py-4 tabular-nums">{row.sessions}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
