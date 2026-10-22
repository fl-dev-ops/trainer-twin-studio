"use client";

import { createContext, useContext, type ReactNode } from "react";
import { ORG_COPY, ORG_KEY, type OrgCopy, type OrgType } from "@/lib/org-type";

const OrgTypeContext = createContext<OrgType | null>(null);

/** Makes the signed-in organization's type available to client components. */
export function OrgTypeProvider({ type, children }: { type: OrgType | null; children: ReactNode }) {
  return <OrgTypeContext.Provider value={type}>{children}</OrgTypeContext.Provider>;
}

export function useOrgType(): OrgType | null {
  return useContext(OrgTypeContext);
}

/** Wording for the org's type ("Role play" for sales, "Scenario" for technical interview). */
export function useOrgCopy(): OrgCopy {
  const type = useOrgType();
  return ORG_COPY[type ? ORG_KEY[type] : "technical"];
}
