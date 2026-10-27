import { UserAvatarGroup } from "@/components/user-avatar";
import { cn } from "@/lib/utils";

/** Pieces shared by the twin and role-play library cards (reference rp-card). */

/** Gradient banner art behind the quote bubble (reference rp-art--N palette). */
export const GRADIENTS = [
  "bg-[linear-gradient(135deg,#a8c6ec_0%,#d2c3e8_50%,#f1c6d7_100%)]",
  "bg-[linear-gradient(135deg,#a8e0c9_0%,#bfe0e8_50%,#c7cdf2_100%)]",
  "bg-[linear-gradient(135deg,#f3cfa0_0%,#f0bcc7_50%,#ddb8ea_100%)]",
  "bg-[linear-gradient(135deg,#cbe3a8_0%,#bfe6cf_50%,#a8e0e0_100%)]",
  "bg-[linear-gradient(135deg,#f6d9a0_0%,#f2c2b0_50%,#ecb6cc_100%)]",
  "bg-[linear-gradient(135deg,#b8cdf0_0%,#c8c4ec_50%,#e0c0e8_100%)]",
  "bg-[linear-gradient(135deg,#f0e3a0_0%,#ecd0b0_50%,#e8bcc4_100%)]",
  "bg-[linear-gradient(135deg,#a0e4e0_0%,#b8d4ec_50%,#ccc8f0_100%)]",
  "bg-[linear-gradient(135deg,#f0c8a8_0%,#eec0d0_50%,#d8bce8_100%)]",
  "bg-[linear-gradient(135deg,#bcead0_0%,#c4e0e4_50%,#d4d0f0_100%)]",
];

/** More-actions dots (reference 16px glyphs, three 1.15r circles). */
export function DotsIcon() {
  return (
    <svg viewBox="0 0 16 16" width={16} height={16} aria-hidden>
      <circle cx="8" cy="3.25" r="1.15" fill="currentColor" />
      <circle cx="8" cy="8" r="1.15" fill="currentColor" />
      <circle cx="8" cy="12.75" r="1.15" fill="currentColor" />
    </svg>
  );
}

/** Learners assigned (avatars with a +N chip), or a quiet note when nobody is. */
export function LearnerAvatars({ learners, className, label = "Learners who talk to your twin" }: { learners: { name: string; email: string; image: string | null }[]; className?: string; label?: string }) {
  if (!learners.length) return <span className={cn("text-xs text-muted-foreground", className)}>No learners yet</span>;
  return (
    <span className={cn("flex items-center", className)} aria-label={label}>
      <UserAvatarGroup users={learners} max={4} size="sm" />
    </span>
  );
}

