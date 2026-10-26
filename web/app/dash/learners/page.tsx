import { redirect } from "next/navigation";
import { LearnersTable } from "@/components/learners/learners-table";
import { listLearners } from "@/lib/learners";
import { getTrainerOrg } from "@/lib/org";

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  const trainer = await getTrainerOrg();
  if (!trainer) redirect("/auth/no-org");
  return <LearnersTable learners={await listLearners(trainer.id, "ROLEPLAY")} />;
}
