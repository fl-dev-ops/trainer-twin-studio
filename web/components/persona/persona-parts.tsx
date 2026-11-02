import type { ReactNode } from "react";
import { UserAvatar } from "@/components/user-avatar";
import { cn } from "@/lib/utils";

/** Shared persona visuals (Persona Library card, detail page): photo, chips, tags, labels. */

export const CARD = "rounded-tt-lg border border-(--card-border) bg-card shadow-card";

/** The persona's avatar photo, or their initial on a stable colour. */
/** A persona's photo sizes: the library card (48), the editor (64), the persona page (96). */
const PHOTO_SIZES = { md: "size-12 text-lg", lg: "size-16 text-xl", xl: "size-24 text-3xl" } as const;

/** A persona's photo, or their initial, ringed in the card colour so it lifts off the card. */
export function PersonaPhoto({ name, photoUrl, size = "md", className }: { name: string; photoUrl: string | null; size?: keyof typeof PHOTO_SIZES; className?: string }) {
  return photoUrl ? (
    // eslint-disable-next-line @next/next/no-img-element -- same-site avatar route that redirects to a presigned S3 URL
    <img src={photoUrl} alt="" className={cn("shrink-0 rounded-full bg-(--tone-control) object-cover object-[center_15%] shadow-elevation-1 ring-3 ring-card", PHOTO_SIZES[size], className)} />
  ) : (
    <UserAvatar user={{ name }} className={cn("shadow-elevation-1 ring-3 ring-card", PHOTO_SIZES[size], className)} />
  );
}

export function RoleChip({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("rounded-full bg-(--tone-control) px-3 py-0.5 text-body-s leading-5 font-medium text-(--text-secondary)", className)}>{children}</span>;
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
  return <p className="m-0 text-xs leading-4 font-medium tracking-overline text-muted-foreground uppercase">{children}</p>;
}
