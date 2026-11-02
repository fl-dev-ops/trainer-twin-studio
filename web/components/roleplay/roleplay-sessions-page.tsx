import { SessionsIcon } from "@/components/icons";
import { RoleplaySessionItem, type RoleplaySessionItemData } from "@/components/roleplay/roleplay-session-item";
import { PageContainer } from "@/components/page-container";

/** Role play sessions (reference pageSessions): every practice session on the org's role plays. */
export function RoleplaySessionsPage({ sessions }: { sessions: RoleplaySessionItemData[] }) {
  return (
    <PageContainer>
      <header className="flex min-h-10 items-center">
        <h1 className="m-0 flex items-center gap-2 text-page-title leading-page-title font-semibold tracking-title">
          <span className="grid size-7 place-items-center rounded-tt-sm text-(--text-secondary)">
            <SessionsIcon className="size-[18px]" />
          </span>
          Role play sessions
        </h1>
      </header>
      <div className="mt-10">
        <h2 className="text-section-title leading-6 font-semibold tracking-title">Practice sessions</h2>
        <p className="mt-1 text-sm text-muted-foreground">Sessions your learners took on your role plays</p>
      </div>
      <ul className="m-0 mt-5 flex list-none flex-col overflow-hidden rounded-tt-lg border border-(--card-border) bg-card p-0 shadow-card">
        {sessions.length === 0 ? <li className="p-6 text-center text-sm text-muted-foreground">No practice sessions yet.</li> : null}
        {sessions.map((session, i) => (
          <RoleplaySessionItem key={session.id} session={session} divider={i > 0} />
        ))}
      </ul>
    </PageContainer>
  );
}
