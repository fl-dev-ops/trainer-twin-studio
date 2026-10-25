"use client";

import type { ReactNode } from "react";

export const RECORDING_ID = "session-recording";

/** Jumps the session recording to `seconds` and plays it. */
export function SeekButton({ seconds, className, children }: { seconds: number; className?: string; children: ReactNode }) {
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        const video = document.getElementById(RECORDING_ID) as HTMLVideoElement | null;
        if (!video) return;
        video.currentTime = seconds;
        void video.play().catch(() => {});
        video.scrollIntoView({ behavior: "smooth", block: "center" });
      }}
    >
      {children}
    </button>
  );
}
