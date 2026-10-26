import { redirect } from "next/navigation";
import { HomeCopilot } from "@/components/home-copilot";
import { getSessionOrg } from "@/lib/org";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  // Sales orgs work with role plays only; the Copilot home builds trainer twins.
  const org = await getSessionOrg();
  if (org?.type === "SALES") redirect("/agents");
  return <HomeCopilot />;
}
