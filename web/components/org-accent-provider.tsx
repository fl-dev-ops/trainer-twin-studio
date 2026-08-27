"use client";

import type { CSSProperties, ReactNode } from "react";

/**
 * Injects org accent color into the CSS cascade by overriding --brand and
 * --brand-strong on a wrapping div. All Shadcn tokens that resolve through
 * those vars (--primary, --ring, --sidebar-primary, --sidebar-ring) pick up
 * the new color automatically via CSS inheritance.
 *
 * NOTE: intentionally no className="contents" — browsers do not propagate
 * inline CSS custom properties through display:contents elements, which would
 * silently break the cascade. The plain <div> wrapper is layout-neutral in
 * these contexts (both layouts sit inside a block parent that handles sizing).
 *
 * ponytail PT-2: --brand and --brand-strong both set to the same hex; the
 * original 15% darkening is skipped. Add OKLCH-aware derivation when the
 * design system matures.
 * ponytail PT-3: --primary-foreground stays #fff; add contrast check if
 * the picker is ever user-public beyond org admins.
 */
export function OrgAccentProvider({
  accentColor,
  children,
}: {
  accentColor: string | null;
  children: ReactNode;
}) {
  const style: CSSProperties | undefined = accentColor
    ? ({
        "--brand": accentColor,
        "--brand-strong": accentColor,
      } as CSSProperties)
    : undefined;

  return (
    <div style={style}>
      {children}
    </div>
  );
}
