"use client";

import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ThemeDarkIcon, ThemeLightIcon } from "@/components/icons";

/** Reference "theme-switch": 32px square, 8px radius, 16px glyph, secondary text colour. */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);
  if (!mounted) return <span className="inline-block size-8" />;

  const dark = resolvedTheme === "dark";
  const label = dark ? "Switch to light" : "Switch to dark";
  return (
    <Button
      variant="subtle"
      size="icon"
      onClick={() => setTheme(dark ? "light" : "dark")}
      aria-label={label}
      aria-pressed={dark}
      title={label}
      className="group/switch"
    >
      {dark ? <ThemeDarkIcon /> : <ThemeLightIcon />}
    </Button>
  );
}
