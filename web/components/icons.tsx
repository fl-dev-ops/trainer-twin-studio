import type { SVGProps } from "react";

/**
 * Studio nav/page icons, matching the V2 prototype (Tabler icon paths, MIT).
 * Inlined instead of adding @tabler/icons-react for a handful of glyphs.
 */
function tabler(paths: string[], name: string) {
  function Icon(props: SVGProps<SVGSVGElement>) {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        {...props}
      >
        {paths.map((d) => (
          <path key={d} d={d} />
        ))}
      </svg>
    );
  }
  Icon.displayName = name;
  return Icon;
}

/** Sessions (prototype: "Twin sessions"). */
export const SessionsIcon = tabler(
  [
    "M21 14l-3 -3h-7a1 1 0 0 1 -1 -1v-6a1 1 0 0 1 1 -1h9a1 1 0 0 1 1 1v10",
    "M14 15v2a1 1 0 0 1 -1 1h-7l-3 3v-10a1 1 0 0 1 1 -1h2",
  ],
  "SessionsIcon",
);

/** Roleplay (prototype: "Scenarios"). */
export const RoleplayIcon = tabler(
  ["M8 7a4 4 0 1 0 8 0a4 4 0 0 0 -8 0", "M6 21v-2a4 4 0 0 1 4 -4h4", "M15 19l2 2l4 -4"],
  "RoleplayIcon",
);

/** Persona (prototype: "Persona Library"; Tabler user-square-rounded). */
export const PersonaIcon = tabler(
  [
    "M12 13a3 3 0 1 0 0 -6a3 3 0 0 0 0 6z",
    "M12 3c7.2 0 9 1.8 9 9s-1.8 9 -9 9s-9 -1.8 -9 -9s1.8 -9 9 -9z",
    "M6 20.05v-.05a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v.05",
  ],
  "PersonaIcon",
);

/** Twin (prototype: "Twin's brain"). */
export const TwinIcon = tabler(
  [
    "M17 21v-1.25c0 -2.311 .778 -1.92 2.244 -3.749a8 8 0 1 0 -14.244 -5.001q 0 .25 -1.876 3.518a1 1 0 0 0 .876 1.482h2v3a2 2 0 0 0 2 2h3",
    "M12 11a1 1 0 1 0 2 0a1 1 0 1 0 -2 0",
  ],
  "TwinIcon",
);

/** Users (prototype: "Twin users"). */
export const UsersIcon = tabler(
  [
    "M9 7m-4 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0",
    "M3 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2",
    "M16 3.13a4 4 0 0 1 0 7.75",
    "M21 21v-2a4 4 0 0 0 -3 -3.85",
  ],
  "UsersIcon",
);

export const SettingsIcon = tabler(
  [
    "M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065",
    "M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0",
  ],
  "SettingsIcon",
);

/** Reference theme-glyphs: 16px grid, 1.5 stroke (prototype "theme-switch"). */
function refIcon(paths: string[], name: string) {
  function Icon(props: SVGProps<SVGSVGElement>) {
    return (
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        {...props}
      >
        {paths.map((d) => (
          <path key={d} d={d} />
        ))}
      </svg>
    );
  }
  Icon.displayName = name;
  return Icon;
}

export const ThemeLightIcon = refIcon(
  [
    "M8 5.75a2.25 2.25 0 1 0 0 4.5a2.25 2.25 0 1 0 0-4.5Z",
    "M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1",
  ],
  "ThemeLightIcon",
);

export const ThemeDarkIcon = refIcon(
  ["M9.2 2.2a5.2 5.2 0 1 0 4.6 7.6 4.4 4.4 0 0 1-4.6-7.6Z"],
  "ThemeDarkIcon",
);

/** Twin landing glyph (prototype: "Twin agents" sparkle). */
export const SetupIcon = tabler(
  [
    "M16 18a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2",
    "M16 6a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2",
    "M9 18a6 6 0 0 1 6 -6a6 6 0 0 1 -6 -6a6 6 0 0 1 -6 6a6 6 0 0 1 6 6",
  ],
  "SetupIcon",
);

/** The TrainerTwin mark (sidebar brand, learner pages). */
export function BrandMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 441 441" fill="currentColor" aria-hidden {...props}>
      <path d="M20 0L421 0A20 20 0 0 1 441 20L441 127A20 20 0 0 1 421 147L314 147A20 20 0 0 0 294 167L294 274A20 20 0 0 0 314 294L421 294A20 20 0 0 1 441 314L441 421A20 20 0 0 1 421 441L314 441A20 20 0 0 1 294 421L294 314A20 20 0 0 0 274 294L167 294A20 20 0 0 0 147 314L147 421A20 20 0 0 1 127 441L20 441A20 20 0 0 1 0 421L0 314A20 20 0 0 1 20 294L127 294A20 20 0 0 0 147 274L147 167A20 20 0 0 0 127 147L20 147A20 20 0 0 1 0 127L0 20A20 20 0 0 1 20 0Z" />
    </svg>
  );
}
