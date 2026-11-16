import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Only layout. SessionView retains media, transcript, surface and lifecycle ownership. */
export function SessionConversationLayout({ workspace, portrait, selfView, transcript, transcriptOpen, name, time }: {
  workspace?: ReactNode;
  portrait: ReactNode;
  selfView: ReactNode;
  transcript: ReactNode;
  transcriptOpen: boolean;
  name: string;
  time: string;
}) {
  const working = Boolean(workspace);
  return <div data-testid="conversation-layout" className={cn("flex min-h-0 min-w-0 flex-1 flex-col gap-4", working && "md:flex-row md:gap-6")}>
    {working && <div className="order-2 flex min-h-0 min-w-0 flex-1 md:order-1">{workspace}</div>}
    <aside aria-label="Call conversation" className={cn(
      "order-1 flex min-h-0 min-w-0 items-center md:order-2",
      working ? "shrink-0 gap-4 md:w-[min(32vw,360px)] md:flex-col md:gap-3 md:px-2 md:pt-3" : "mx-auto w-full max-w-[520px] flex-1 flex-col px-4 pt-3",
    )}>
      <div className={cn("relative shrink-0", working ? "size-16 md:size-40" : "size-[min(320px,32dvh)]")}>
        {portrait}
        <div aria-label="Your camera preview" className={cn("absolute -right-3 bottom-0 aspect-[4/3] overflow-hidden rounded-xl border-2 border-background shadow-elevation-2", working ? "w-10 md:w-20" : "w-20 sm:-right-6 sm:w-24")}>
          {selfView}
        </div>
      </div>
      <div className={cn("flex shrink-0 flex-col gap-1", working ? "min-w-0 md:items-center md:text-center" : "items-center pt-3 text-center")}>
        <p className="m-0 max-w-full truncate text-sm font-medium">{name}</p>
        <time aria-label="Session time" className="text-xs text-muted-foreground tabular-nums">{time}</time>
      </div>
      {transcriptOpen && <div className={cn("min-h-0 w-full flex-1", working ? "hidden md:flex" : "mt-3 flex")}>{transcript}</div>}
    </aside>
  </div>;
}
