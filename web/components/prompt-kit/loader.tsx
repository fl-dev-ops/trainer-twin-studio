import { cn } from "@/lib/utils";

export function CircularLoader({ className, size = "md" }: { className?: string; size?: "sm" | "md" | "lg" }) {
  const sizes = { sm: "size-4", md: "size-5", lg: "size-6" };
  return (
    <span className={cn("animate-spin rounded-full border-2 border-primary border-t-transparent", sizes[size], className)} role="status">
      <span className="sr-only">Loading</span>
    </span>
  );
}
