import { RoleplaySessionReportPage } from "@/components/roleplay/roleplay-session-report-page";
import { orNotFound, roleplayServer } from "@/lib/roleplay/server";

export const dynamic = "force-dynamic";

/** One role-play session's report. */
export default async function RoleplaySessionRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const roleplay = await roleplayServer();
  return <RoleplaySessionReportPage session={await orNotFound(roleplay.sessions.get({ id }))} />;
}
