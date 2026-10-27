import { SessionsIcon } from "@/components/icons";
import { RoleplaySessionItem, type RoleplaySessionItemData } from "@/components/roleplay/roleplay-session-item";

/** Role play sessions (reference pageSessions): every practice session on the org's role plays. */
export function RoleplaySessionsPage({ sessions }: { sessions: RoleplaySessionItemData[] }) {
  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[1024px] px-4 pt-5 pb-16 md:px-0">
        <header className="flex min-h-10 items-center">
          <h1 className="m-0 flex items-center gap-2 text-[16px] leading-[22px] font-semibold tracking-[-0.015em]">
            <span className="grid size-7 place-items-center rounded-[8px] text-(--text-secondary)">
              <SessionsIcon className="size-[18px]" />
            </span>
            Role play sessions
          </h1>
        </header>
        <div className="mt-10">
          <h2 className="text-[18px] leading-6 font-semibold tracking-[-0.015em]">Practice sessions</h2>
          <p className="mt-1 text-sm text-muted-foreground">Sessions your learners took on your role plays</p>
        </div>
        <ul className="m-0 mt-5 flex list-none flex-col overflow-hidden rounded-[16px] border border-(--card-border) bg-card p-0 shadow-[0_2px_4px_rgb(30_28_25/0.035),0_8px_20px_rgb(30_28_25/0.055)]">
          {sessions.length === 0 ? <li className="p-6 text-center text-sm text-muted-foreground">No practice sessions yet.</li> : null}
          {sessions.map((session, i) => (
            <RoleplaySessionItem key={session.id} session={session} index={i} divider={i > 0} />
          ))}
        </ul>
      </div>
    </div>
  );
}
