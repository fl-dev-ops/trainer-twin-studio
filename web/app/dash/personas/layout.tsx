import type { ReactNode } from "react";
import { requireRoleplayOrg } from "@/lib/org";

export const dynamic = "force-dynamic";

/** Personas sit under Role play in the menu: twin-only orgs go to /twin. */
export default async function PersonasLayout({ children }: { children: ReactNode }) {
  await requireRoleplayOrg();
  return children;
}
