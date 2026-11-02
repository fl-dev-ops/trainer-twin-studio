import { UsersIcon } from "@/components/icons";
import { UserAvatar } from "@/components/user-avatar";
import type { RoleplayOutputs } from "@/lib/roleplay/trpc";
import { cn } from "@/lib/utils";
import { PageContainer } from "@/components/page-container";

// Inline so the columns never depend on a freshly generated utility class.
// Name, email, role plays assigned, sessions.
const columns = "grid grid-cols-[minmax(0,1.3fr)_minmax(0,1.6fr)_150px_110px] items-center gap-3";

/** Roleplay users (reference pageRoleUsers): everyone invited to or practising on the org's role plays. */
export function RoleplayUsersPage({ users }: { users: RoleplayOutputs["users"]["list"] }) {
  return (
    <PageContainer>
      <header className="flex min-h-10 items-center">
        <h1 className="m-0 flex items-center gap-2 text-page-title leading-page-title font-semibold tracking-title">
          <span className="grid size-7 place-items-center rounded-tt-sm text-(--text-secondary)">
            <UsersIcon className="size-[18px]" />
          </span>
          Roleplay users
        </h1>
      </header>
      <div className="mt-10">
        <h2 className="m-0 text-section-title leading-6 font-semibold tracking-title">All users</h2>
        <p className="mt-1 text-sm text-muted-foreground">People practising on your roleplays</p>
      </div>
      <div className="mt-4 overflow-hidden rounded-tt-lg border border-(--card-border) bg-card shadow-card">
        <div className={cn(columns, "bg-(--sidebar) px-5 py-2.5 text-overline font-medium tracking-overline text-(--text-secondary) uppercase")}>
          <span>Name</span>
          <span>Email</span>
          <span>Roleplays assigned</span>
          <span>Sessions</span>
        </div>
        {users.length === 0 ? (
          <p className="border-t border-(--border) px-5 py-6 text-center text-sm text-muted-foreground">Nobody yet. Assign a role play to invite people.</p>
        ) : null}
        {users.map((user) => (
          <div key={user.email} className={cn(columns, "border-t border-(--border) px-5 py-3.5 text-sm")}>
            <span className="flex min-w-0 items-center gap-3 font-medium">
              <UserAvatar user={user} size="sm" />
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
    </PageContainer>
  );
}
