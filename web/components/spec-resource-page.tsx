"use client";

import { SpecResourceEditor } from "@/components/spec-resource";
import type { SpecResourceView } from "@/lib/pages/spec-resource";

/** A persona's spec page: what lib/pages/spec-resource.ts loaded. */
export function SpecResourcePage({ loaded }: { loaded: SpecResourceView }) {
  return <SpecResourceEditor key={loaded.key} {...loaded.props} />;
}
