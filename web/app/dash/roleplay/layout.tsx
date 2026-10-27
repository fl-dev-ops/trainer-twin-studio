import type { ReactNode } from "react";
import { requireStudioMember } from "@/lib/org";

export const dynamic = "force-dynamic";

/** Every /roleplay page is for admin and team only (pages and the tRPC router check again). */
export default async function RoleplayLayout({ children }: { children: ReactNode }) {
  await requireStudioMember();
  return children;
}
