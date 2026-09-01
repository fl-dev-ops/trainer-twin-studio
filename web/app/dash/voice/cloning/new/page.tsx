import { redirect } from "next/navigation";
import { resolveSessionUser } from "@/lib/session-user";
import { dashLink } from "@/lib/tenant-link";

export default async function NewVoicePage() {
  const { org } = await resolveSessionUser();
  redirect(dashLink("/voice/cloning", org?.basePath));
}
