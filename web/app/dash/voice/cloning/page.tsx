"use client";

import dynamic from "next/dynamic";

// Client-only: recording needs mic permissions, and the passage is randomized.
const VoiceCloning = dynamic(() => import("./cloning"), { ssr: false });

export default function Page() {
  return <VoiceCloning />;
}
