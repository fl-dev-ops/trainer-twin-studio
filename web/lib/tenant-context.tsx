"use client";

import { createContext, useContext, type ReactNode } from "react";

const TenantContext = createContext<string | null>(null);

export function TenantBasePathProvider({
  basePath,
  children,
}: {
  basePath: string | null;
  children: ReactNode;
}) {
  return (
    <TenantContext.Provider value={basePath}>
      {children}
    </TenantContext.Provider>
  );
}

export function useTenantBasePath(): string | null {
  return useContext(TenantContext);
}
