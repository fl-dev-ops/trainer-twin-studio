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
      variant="ghost"
      onClick={() => setTheme(dark ? "light" : "dark")}
      aria-label={label}
      aria-pressed={dark}
      title={label}
      className="group/switch size-8 rounded-md p-0 text-(--text-secondary) shadow-none hover:bg-(--tone-control) hover:text-foreground dark:hover:bg-(--tone-control) dark:hover:text-foreground [&_svg]:size-4"
    >
      {dark ? <ThemeDarkIcon /> : <ThemeLightIcon />}
    </Button>
  );
}
