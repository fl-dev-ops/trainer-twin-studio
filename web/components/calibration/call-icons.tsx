import type { SVGProps } from "react";

/** Call and calibration icons, copied from the V2 prototype so the call screen matches it. */
type P = SVGProps<SVGSVGElement>;
const base = { viewBox: "0 0 24 24", fill: "none", "aria-hidden": true } as const;
const line = { stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round" } as const;

export function MicIcon({ off, ...props }: P & { off?: boolean }) {
  return (
    <svg {...base} {...props}>
      <path d="M12 15a4 4 0 0 0 4-4V6a4 4 0 0 0-8 0v5a4 4 0 0 0 4 4Z" fill="currentColor" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" {...line} strokeWidth={2} />
      {off ? <path d="m3 3 18 18" {...line} strokeWidth={2} /> : null}
    </svg>
  );
}

export function ChatIcon(props: P) {
  return (
    <svg {...base} {...props}>
      <path
        d="M18 3.5H6A3.5 3.5 0 0 0 2.5 7v8A3.5 3.5 0 0 0 6 18.5h1.5v3.2a.4.4 0 0 0 .62.33L13 18.5h5a3.5 3.5 0 0 0 3.5-3.5V7A3.5 3.5 0 0 0 18 3.5Z"
        fill="currentColor"
      />
      {/* The lines punch through the bubble in whatever the button's background is. */}
      <path d="M7.5 9h9M7.5 13h6" stroke="var(--call-chat-lines, #fff)" strokeWidth={1.6} strokeLinecap="round" />
    </svg>
  );
}

export function HangUpIcon(props: P) {
  return (
    <svg {...base} {...props}>
      <path
        d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08a.99.99 0 0 1-.29-.7c0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28a11.27 11.27 0 0 0-2.67-1.85.996.996 0 0 1-.56-.9v-3.1C15.15 9.25 13.6 9 12 9Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function PhoneIcon(props: P) {
  return (
    <svg {...base} {...line} strokeWidth={2} {...props}>
      <path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2" />
    </svg>
  );
}

export function CallEndedIcon(props: P) {
  return (
    <svg {...base} {...line} strokeWidth={1.8} {...props}>
      <path d="M10.1 13.9a14 14 0 0 0 3.732 2.668 1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2 18 18 0 0 1-12.728-5.272" />
      <path d="M22 2 2 22" />
      <path d="M4.76 13.582A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 .244.473" />
    </svg>
  );
}

export function FeelsLikeMeIcon(props: P) {
  return (
    <svg {...base} {...props}>
      <path
        d="M7 11v9H4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3zm0 0 4.2-6.3A1.5 1.5 0 0 1 14 5.6V9h4.2a2 2 0 0 1 2 2.3l-1 6.5a2 2 0 0 1-2 1.7H7"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function FeelsOffIcon(props: P) {
  return (
    <svg {...base} {...props}>
      <path
        d="M7 13V4H4a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h3zm0 0 4.2 6.3A1.5 1.5 0 0 0 14 18.4V15h4.2a2 2 0 0 0 2-2.3l-1-6.5a2 2 0 0 0-2-1.7H7"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** "Why did the twin say this?" — a document with a sparkle. */
export function WhyIcon(props: P) {
  return (
    <svg {...base} {...line} strokeWidth={2} {...props}>
      <path d="M14 3v4a1 1 0 0 0 1 1h4" />
      <path d="M12 21h-5a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v3.5" />
      <path d="M9 9h1M9 13h6M9 17h3" />
      <path d="M19 22.5a4.75 4.75 0 0 1 3.5 -3.5a4.75 4.75 0 0 1 -3.5 -3.5a4.75 4.75 0 0 1 -3.5 3.5a4.75 4.75 0 0 1 3.5 3.5" />
    </svg>
  );
}

export function CloseIcon(props: P) {
  return (
    <svg {...base} {...props}>
      <path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" />
    </svg>
  );
}

export function ArrowUpRightIcon(props: P) {
  return (
    <svg {...base} {...line} strokeWidth={1.8} {...props}>
      <path d="M7 17 17 7M8 7h9v9" />
    </svg>
  );
}

const SOURCE_PATHS = {
  slides: ["M3 4h18", "M4 4v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-10", "M12 16v4M9 20h6M8 12l3 -3l2 2l3 -3"],
  notion: ["M4 6a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2z", "M9 16v-8l6 8v-8"],
  doc: ["M14 3v4a1 1 0 0 0 1 1h4", "M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2z", "M9 13h6M9 17h4"],
  video: [],
} as const;

export type SourceKind = keyof typeof SOURCE_PATHS;

export function SourceIcon({ kind, ...props }: P & { kind: SourceKind }) {
  return (
    <svg {...base} {...line} strokeWidth={1.8} {...props}>
      {kind === "video" ? (
        <>
          <rect x="3" y="5" width="18" height="14" rx="4" />
          <path d="m10 9.5 5 2.5-5 2.5z" fill="currentColor" />
        </>
      ) : (
        SOURCE_PATHS[kind].map((d) => <path key={d} d={d} />)
      )}
    </svg>
  );
}
