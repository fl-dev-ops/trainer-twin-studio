import type { ReactNode } from "react";
import { requireRoleplayOrg } from "@/lib/org";

export const dynamic = "force-dynamic";

/** Every /roleplay page is for admin and team only (pages and the tRPC router check again); twin-only orgs go to /twin. */
export default async function RoleplayLayout({ children }: { children: ReactNode }) {
  await requireRoleplayOrg();
  return children;
}
