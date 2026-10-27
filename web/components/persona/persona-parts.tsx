import type { ReactNode } from "react";
import { UserAvatar } from "@/components/user-avatar";
import { cn } from "@/lib/utils";

/** Shared persona visuals (Persona Library card, detail page): photo, chips, tags, labels. */

export const CARD = "rounded-[16px] border border-(--card-border) bg-card shadow-[0_2px_4px_rgb(30_28_25/0.035),0_8px_20px_rgb(30_28_25/0.055)]";

/** The persona's avatar photo, or their initial on a stable colour. */
export function PersonaPhoto({ name, photoUrl, className }: { name: string; photoUrl: string | null; className: string }) {
  return photoUrl ? (
    // eslint-disable-next-line @next/next/no-img-element -- same-site avatar route that redirects to a presigned S3 URL
    <img src={photoUrl} alt="" className={cn("shrink-0 rounded-full bg-(--tone-control) object-cover object-[center_15%] shadow-[0_0_0_3px_var(--card),0_1px_6px_rgb(0_0_0/0.12)]", className)} />
  ) : (
    <UserAvatar user={{ name }} className={cn("shadow-[0_0_0_3px_var(--card),0_1px_6px_rgb(0_0_0/0.12)]", className)} />
  );
}

export function RoleChip({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("rounded-full bg-(--tone-control) px-3 py-0.5 text-[13px] leading-5 font-medium text-(--text-secondary)", className)}>{children}</span>;
}

export function Tags({ items }: { items: string[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <span key={item} className="rounded-full bg-(--tone-control) px-2.5 py-0.5 text-xs leading-5 font-medium text-(--text-secondary)">{item}</span>
      ))}
    </div>
  );
}

export function ItemLabel({ children }: { children: ReactNode }) {
  return <p className="m-0 text-xs leading-4 font-medium tracking-[0.06em] text-muted-foreground uppercase">{children}</p>;
}
