import { cn } from "@/lib/utils";

// The five V4 avatar washes (text colour on a light tint), cycled by row.
const WASHES = [
  "bg-[#edf9f1] text-[#1a6739]",
  "bg-[#eef4ff] text-[#2a63c4]",
  "bg-[#fdf6e3] text-[#7f5f00]",
  "bg-[#fff1f1] text-[#ce2c33]",
  "bg-[#ffe3d1] text-[#b83e00]",
];

export function LearnerAvatar({ name, index, className }: { name: string; index: number; className?: string }) {
  return (
    <span aria-hidden className={cn("grid shrink-0 place-items-center rounded-full font-semibold", WASHES[index % WASHES.length], className)}>
      {(name.trim().charAt(0) || "?").toUpperCase()}
    </span>
  );
}
