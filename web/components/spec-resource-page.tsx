"use client";

import { AgentEditor } from "@/components/agent-editor";
import { SpecResourceEditor } from "@/components/spec-resource";
import type { SpecResourceView } from "@/lib/pages/spec-resource";

/** /agents/<slug>/edit and a persona's spec page: what lib/pages/spec-resource.ts loaded. */
export function SpecResourcePage({ loaded }: { loaded: SpecResourceView }) {
  return loaded.view === "agent" ? (
    <AgentEditor key={loaded.key} {...loaded.props} />
  ) : (
    <SpecResourceEditor key={loaded.key} {...loaded.props} />
  );
}
