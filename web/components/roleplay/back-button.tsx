"use client";

import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";

/** Goes back to wherever the report was opened from (sessions list or role play), else the sessions list. */
export function BackButton({ label, fallback }: { label: string; fallback: string }) {
  const router = useRouter();
  return (
    <button type="button" className="inline-flex items-center gap-2 text-sm hover:underline"
      onClick={() => (window.history.length > 1 ? router.back() : router.push(fallback))}>
      <ArrowLeft className="size-4" /> {label}
    </button>
  );
}
