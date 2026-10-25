import { redirect } from "next/navigation";
import { SessionsList, type SessionsSearchParams } from "@/components/sessions/sessions-list";
import { getTrainerOrg } from "@/lib/org";

export const dynamic = "force-dynamic";

export default async function SessionsPage({ searchParams }: { searchParams: Promise<SessionsSearchParams> }) {
  const trainer = await getTrainerOrg();
  if (!trainer) redirect("/auth/no-org");
  return <SessionsList orgId={trainer.id} params={await searchParams} />;
}
