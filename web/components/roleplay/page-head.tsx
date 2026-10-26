import type { ReactNode } from "react";

/** V4 page head: an icon and title at the top, then a section title with its note on the right. */
export function RoleplayPageHead({ icon, title, section, note }: { icon: ReactNode; title: string; section: string; note: string }) {
  return (
    <>
      <h1 className="flex items-center gap-3 text-[15px] font-medium">
        <span className="text-muted-foreground [&_svg]:size-[18px]">{icon}</span>{title}
      </h1>
      <div className="mt-14 mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold tracking-[-0.01em]">{section}</h2>
        <p className="text-sm text-muted-foreground">{note}</p>
      </div>
    </>
  );
}
