"use client";

import dynamic from "next/dynamic";

const CopilotChat = dynamic(
  () => import("@/components/copilot-chat").then((module) => module.CopilotChat),
  { ssr: false, loading: () => <main className="min-h-0 flex-1 bg-background" aria-busy="true" /> },
);

export default function HomePage() {
  return <CopilotChat />;
}
