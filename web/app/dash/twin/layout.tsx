import type { ReactNode } from "react";
import { requireStudioMember } from "@/lib/org";

export const dynamic = "force-dynamic";

/**
 * Every /twin page (library, sessions, users, calibration) is for admin and team only. Pages also check
 * through twinServer() and the tRPC router, since a layout is not re-run on every client navigation.
 */
export default async function TwinLayout({ children }: { children: ReactNode }) {
  await requireStudioMember();
  return children;
}
