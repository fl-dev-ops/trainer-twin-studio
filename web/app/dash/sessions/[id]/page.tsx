import { redirect } from "next/navigation";
import { SessionDetail } from "@/components/sessions/session-detail";
import { getTrainerOrg } from "@/lib/org";

export const dynamic = "force-dynamic";

export default async function SessionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const trainer = await getTrainerOrg();
  if (!trainer) redirect("/auth/no-org");
  return <SessionDetail orgId={trainer.id} id={(await params).id} />;
}
