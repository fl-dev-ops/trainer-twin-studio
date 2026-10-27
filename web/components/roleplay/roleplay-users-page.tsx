import { UsersIcon } from "@/components/icons";
import type { RoleplayOutputs } from "@/lib/roleplay/trpc";
import { cn } from "@/lib/utils";

const AVATAR_TONES = [
  "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  "bg-rose-500/15 text-rose-600 dark:text-rose-400",
  "bg-orange-500/15 text-orange-600 dark:text-orange-400",
];

const columns = "grid grid-cols-[minmax(0,1.3fr)_minmax(0,1.6fr)_150px_110px] items-center gap-3";

/** Roleplay users (reference pageRoleUsers): everyone invited to or practising on the org's role plays. */
export function RoleplayUsersPage({ users }: { users: RoleplayOutputs["users"]["list"] }) {
  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[1024px] px-4 pt-5 pb-16 md:px-0">
        <header className="flex min-h-10 items-center">
          <h1 className="m-0 flex items-center gap-2 text-[16px] leading-[22px] font-semibold tracking-[-0.015em]">
            <span className="grid size-7 place-items-center rounded-[8px] text-(--text-secondary)">
              <UsersIcon className="size-[18px]" />
            </span>
            Roleplay users
          </h1>
        </header>
        <div className="mt-10">
          <h2 className="m-0 text-[18px] leading-6 font-semibold tracking-[-0.015em]">All users</h2>
          <p className="mt-1 text-sm text-muted-foreground">People practising on your roleplays</p>
        </div>
        <div className="mt-4 overflow-hidden rounded-[16px] border border-(--card-border) bg-card shadow-[0_2px_4px_rgb(30_28_25/0.035),0_8px_20px_rgb(30_28_25/0.055)]">
          <div className={cn(columns, "bg-(--sidebar) px-5 py-2.5 text-[12px] font-medium tracking-[0.04em] text-(--text-secondary) uppercase")}>
            <span>Name</span>
            <span>Email</span>
            <span>Roleplays assigned</span>
            <span>Sessions</span>
          </div>
          {users.length === 0 ? (
            <p className="border-t border-(--border) px-5 py-6 text-center text-sm text-muted-foreground">Nobody yet. Assign a role play to invite people.</p>
          ) : null}
          {users.map((user, i) => (
            <div key={user.email} className={cn(columns, "border-t border-(--border) px-5 py-3.5 text-sm")}>
              <span className="flex min-w-0 items-center gap-3 font-medium">
                <span className={cn("grid size-7 shrink-0 place-items-center rounded-full text-xs font-semibold", AVATAR_TONES[i % AVATAR_TONES.length])} aria-hidden>
                  {user.name.charAt(0).toUpperCase()}
                </span>
                <span className="truncate">{user.name}</span>
              </span>
              <span className="truncate text-muted-foreground">{user.email}</span>
              <span className="tabular-nums">
                {user.roleplays} <span className="font-normal text-muted-foreground">{user.roleplays === 1 ? "roleplay" : "roleplays"}</span>
              </span>
              <span className="tabular-nums">{user.sessions}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
