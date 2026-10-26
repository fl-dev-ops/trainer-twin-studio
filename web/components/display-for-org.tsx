"use client";

import type { ReactNode } from "react";
import { useOrgType } from "@/components/org-type-provider";
import { ORG_KEY, type OrgKey } from "@/lib/org-type";

/**
 * Renders children only for the given org type(s):
 *   <DisplayForOrg org="sales">…</DisplayForOrg>
 *   <DisplayForOrg org={["sales", "technical"]}>…</DisplayForOrg>
 * Hides UI only. Access rules are enforced on the server.
 */
export function DisplayForOrg({ org, children }: { org: OrgKey | OrgKey[]; children: ReactNode }) {
  const type = useOrgType();
  if (!type) return null;
  const allowed = Array.isArray(org) ? org : [org];
  return allowed.includes(ORG_KEY[type]) ? <>{children}</> : null;
}
