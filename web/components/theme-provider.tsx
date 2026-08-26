"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ComponentProps } from "react";

export function ThemeProvider({ children, scriptProps, ...props }: ComponentProps<typeof NextThemesProvider>) {
  // next-themes 0.4.6 renders its startup script again on client remounts,
  // which React 19.2 rejects. Keep SSR executable; client copies are inert.
  const safeScriptProps = typeof window === "undefined"
    ? scriptProps
    : { ...scriptProps, type: "application/json" };
  return <NextThemesProvider {...props} scriptProps={safeScriptProps}>{children}</NextThemesProvider>;
}
