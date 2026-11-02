import { PageContainer } from "@/components/page-container";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * Loading skeletons, built from the same layout classes as the pages they stand in for (PageContainer, the title bar,
 * section titles, list cards, card grids, PageHeader, the pill tabs), so nothing jumps when the data arrives.
 * Each route's loading.tsx picks the skeleton of its page's kind: library, table, detail, report, editor, ...
 */

/** The card surface pages use: rounded 16px, card border, soft shadow. */
const CARD =
  "rounded-[16px] border border-(--card-border) bg-card shadow-[0_2px_4px_rgb(30_28_25/0.035),0_8px_20px_rgb(30_28_25/0.055)]";

const times = (count: number) => Array.from({ length: count }, (_, i) => i);

// ── Building blocks ──────────────────────────────────────────────────────────

/** A page: PageContainer, marked busy. Children space themselves as the page does (mt-*). */
export function LoadingPage({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <PageContainer aria-busy="true" className={className}>
      {children}
    </PageContainer>
  );
}

/** The title bar most pages use (`flex min-h-10`): icon + title, or a back link on detail pages; pill actions right. */
export function LoadingTitleBar({ back = false, actions = 0 }: { back?: boolean; actions?: number }) {
  return (
    <header className="flex min-h-10 items-center justify-between gap-4">
      {back ? (
        <Skeleton className="h-4 w-14" />
      ) : (
        <div className="flex items-center gap-2">
          <Skeleton className="size-7 rounded-[8px]" />
          <Skeleton className="h-4 w-32" />
        </div>
      )}
      {actions ? (
        <div className="flex items-center gap-2.5">
          {times(actions).map((i) => (
            <Skeleton key={i} className="h-8 w-24 rounded-full" />
          ))}
        </div>
      ) : null}
    </header>
  );
}

/** PageHeader (settings, sessions, voices, ...): icon + title, an optional description, actions. */
export function LoadingPageHeader({ description = false, actions = 0, className }: { description?: boolean; actions?: number; className?: string }) {
  return (
    <header className={cn("flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between", className)}>
      <div className="min-w-0">
        <div className="flex min-h-8 items-center gap-2">
          <Skeleton className="size-[18px] rounded-[5px]" />
          <Skeleton className="h-4 w-32" />
        </div>
        {description ? <Skeleton className="mt-2 h-4 w-80 max-w-full" /> : null}
      </div>
      {actions ? (
        <div className="flex items-center gap-2">
          {times(actions).map((i) => (
            <Skeleton key={i} className="h-9 w-28 rounded-md" />
          ))}
        </div>
      ) : null}
    </header>
  );
}

/** A section title: the 18px heading and its one-line note. */
export function LoadingSectionTitle({ className = "mt-10", note = true }: { className?: string; note?: boolean }) {
  return (
    <div className={className}>
      <Skeleton className="h-5 w-40" />
      {note ? <Skeleton className="mt-2 h-4 w-64 max-w-full" /> : null}
    </div>
  );
}

/** A list in a card (users, sessions): rows with an avatar and two lines; `header` adds the column-label row. */
export function LoadingList({ rows = 5, header = false, className = "mt-4" }: { rows?: number; header?: boolean; className?: string }) {
  return (
    <div className={cn(CARD, "overflow-hidden", className)}>
      {header ? (
        <div className="bg-(--sidebar) px-5 py-3">
          <Skeleton className="h-3 w-1/2" />
        </div>
      ) : null}
      {times(rows).map((i) => (
        <div key={i} className={cn("flex items-center gap-3 px-5 py-3.5", (header || i > 0) && "border-t border-(--border)")}>
          <Skeleton className="size-7 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Library cards (twins, role plays, personas, voices): the 1 / 2 / 3 column grid. */
export function LoadingCardGrid({ count = 3, className = "mt-5" }: { count?: number; className?: string }) {
  return (
    <div className={cn("grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3", className)}>
      {times(count).map((i) => (
        <div key={i} className={cn(CARD, "flex h-44 flex-col gap-3 p-5")}>
          <Skeleton className="size-10 rounded-full" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-4/5" />
        </div>
      ))}
    </div>
  );
}

/** One card on a detail page: a heading and a few lines. */
export function LoadingCard({ className, lines = 3 }: { className?: string; lines?: number }) {
  return (
    <div className={cn(CARD, "flex flex-col gap-3 p-6", className)}>
      <Skeleton className="h-5 w-40" />
      {times(lines).map((i) => (
        <Skeleton key={i} className={cn("h-4", i === lines - 1 ? "w-2/3" : "w-full")} />
      ))}
    </div>
  );
}

/** The pill tab bar (components/ui/tabs). */
export function LoadingTabs({ count = 3, className }: { count?: number; className?: string }) {
  return (
    <div className={cn("inline-flex w-fit items-center gap-1 rounded-full bg-(--sidebar) p-1", className)}>
      {times(count).map((i) => (
        <Skeleton key={i} className="h-7 w-20 rounded-full" />
      ))}
    </div>
  );
}

// ── Page kinds ───────────────────────────────────────────────────────────────

/** Library pages (twins, role plays, personas): title bar, section title, card grid. */
export function LoadingLibrary({ actions = 0 }: { actions?: number }) {
  return (
    <LoadingPage>
      <LoadingTitleBar actions={actions} />
      <LoadingSectionTitle note={false} />
      <LoadingCardGrid count={6} />
    </LoadingPage>
  );
}

/** Table pages (twin / role-play users and sessions): title bar, section title, a list card. Also the dash default. */
export function LoadingTable({ actions = 0, header = false }: { actions?: number; header?: boolean }) {
  return (
    <LoadingPage>
      <LoadingTitleBar actions={actions} />
      <LoadingSectionTitle />
      <LoadingList rows={6} header={header} />
    </LoadingPage>
  );
}

/** A twin / role play: back + actions, the two-column cards, then full-width cards. */
export function LoadingDetail({ actions = 1 }: { actions?: number }) {
  return (
    <LoadingPage>
      <LoadingTitleBar back actions={actions} />
      <div className="mt-6 grid grid-cols-1 items-stretch gap-4 md:grid-cols-2">
        <LoadingCard className="h-56" lines={4} />
        <LoadingCard className="h-56" lines={4} />
        <LoadingCard className="md:col-span-2" lines={3} />
        <LoadingList rows={4} className="md:col-span-2" />
      </div>
    </LoadingPage>
  );
}

/** A session report (twin session, role-play session): back, then a stack of cards ending in the transcript. */
export function LoadingReport() {
  return (
    <LoadingPage>
      <LoadingTitleBar back />
      <div className="mt-6 flex flex-col gap-4">
        <LoadingCard lines={2} />
        <LoadingCard lines={4} />
        <LoadingCard lines={6} />
      </div>
    </LoadingPage>
  );
}

/** Editors and builders (persona, role play, twin): back + save, the name block, tabs, the form card, the footer. */
export function LoadingEditor({ tabs = 3 }: { tabs?: number }) {
  return (
    <LoadingPage>
      <LoadingTitleBar back actions={1} />
      <div className="mt-6 space-y-2">
        <Skeleton className="h-7 w-1/2" />
        <Skeleton className="h-4 w-2/3" />
      </div>
      <LoadingTabs count={tabs} className="mt-6" />
      <div className={cn(CARD, "mt-4 flex flex-col gap-5 p-6")}>
        {times(4).map((i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-10 w-full rounded-lg" />
          </div>
        ))}
      </div>
      <div className="mt-6 flex justify-end gap-3">
        <Skeleton className="h-8 w-20 rounded-full" />
        <Skeleton className="h-8 w-24 rounded-full" />
      </div>
    </LoadingPage>
  );
}

/** Full-height editors (agent spec, knowledge base, TTS playground): a toolbar, the main panel, a side panel. */
export function LoadingWorkspace() {
  return (
    <main aria-busy="true" className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex shrink-0 items-center gap-3 border-b px-4 py-3 sm:px-6">
        <Skeleton className="size-8 rounded-md" />
        <Skeleton className="h-4 w-48" />
      </header>
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="min-h-0 flex-1 space-y-4 overflow-hidden p-5 sm:p-8">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
          {times(3).map((i) => (
            <Skeleton key={i} className="h-24 w-full rounded-lg" />
          ))}
        </div>
        <aside className="space-y-3 border-t bg-muted/20 p-4 sm:p-6 lg:w-80 lg:border-t-0 lg:border-l">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-5/6" />
          <Skeleton className="h-3 w-2/3" />
        </aside>
      </div>
    </main>
  );
}

/** Full-screen capture flows (avatar, voice, voice cloning): a centered title and the camera / recorder square. */
export function LoadingCapture() {
  return (
    <section aria-busy="true" className="mx-auto flex w-full max-w-3xl flex-col items-center gap-8 px-5 pt-[4vh] pb-12 sm:px-8">
      <div className="flex flex-col items-center gap-2">
        <Skeleton className="h-6 w-56" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <Skeleton className="size-[min(420px,80vw)] rounded-3xl" />
      <Skeleton className="h-10 w-40 rounded-full" />
    </section>
  );
}

/** The twin's brain: the dotted canvas, its header, the row of node cards. */
export function LoadingBrain() {
  return (
    <div aria-busy="true" className="relative h-full w-full overflow-hidden bg-[radial-gradient(circle,var(--tone-control)_1px,transparent_1px)] bg-size-[20px_20px]">
      <header className="relative z-10 flex h-16 items-center justify-between gap-4 px-5">
        <Skeleton className="h-4 w-14" />
        <Skeleton className="h-8 w-28 rounded-full" />
      </header>
      <div className="absolute inset-0 top-16 flex items-center justify-center gap-6 overflow-hidden p-12">
        {times(3).map((i) => (
          <LoadingCard key={i} className="h-72 w-[340px] shrink-0" lines={5} />
        ))}
      </div>
    </div>
  );
}

/** Talk: the session screen before joining, its header and the "Start a practice session" card. */
export function LoadingSessionScreen() {
  return (
    <div aria-busy="true" className="flex h-dvh w-dvw flex-col overflow-hidden bg-panel text-foreground">
      <header className="grid h-[72px] shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-4 px-6">
        <Skeleton className="h-5 w-28" />
        <Skeleton className="h-4 w-40" />
        <span />
      </header>
      <main className="flex min-h-0 flex-1 items-center justify-center p-4 sm:p-6">
        <div className={cn(CARD, "w-full max-w-md space-y-5 rounded-3xl p-6")}>
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-4 w-full" />
          {times(2).map((i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-9 w-full rounded-lg" />
            </div>
          ))}
          <Skeleton className="h-10 w-full rounded-full" />
        </div>
      </main>
    </div>
  );
}

/** A calibration call: the scenario name, then the centered twin. */
export function LoadingCalibrationCall() {
  return (
    <div aria-busy="true" className="relative flex h-dvh max-h-dvh flex-col overflow-hidden">
      <Skeleton className="mx-8 mt-6 h-4 w-48" />
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-6">
        <Skeleton className="size-24 rounded-full" />
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-4 w-64 max-w-full" />
      </div>
      <div className="flex justify-center gap-3 pb-10">
        {times(3).map((i) => (
          <Skeleton key={i} className="size-12 rounded-full" />
        ))}
      </div>
    </div>
  );
}

/** A twin's calibrations: back, the centered twin, four stat cards, the list (calibration keeps its own width). */
export function LoadingCalibrationOverview() {
  return (
    <div aria-busy="true" className="h-full w-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[800px] px-4 pt-5 pb-10 md:px-0">
        <LoadingTitleBar back actions={1} />
        <div className="mt-6 flex flex-col items-center gap-3">
          <Skeleton className="size-16 rounded-full" />
          <Skeleton className="h-6 w-48" />
        </div>
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {times(4).map((i) => (
            <Skeleton key={i} className="h-20 rounded-[12px]" />
          ))}
        </div>
        <LoadingList rows={4} className="mt-6" />
      </div>
    </div>
  );
}

/** One calibration's transcript: back, then the centered twin and the conversation. */
export function LoadingCalibrationReview() {
  return (
    <div aria-busy="true" className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-6">
      <Skeleton className="mx-2 h-4 w-14" />
      <div className="mx-auto flex w-full max-w-[656px] flex-col items-center pt-8 pb-10">
        <Skeleton className="size-16 rounded-full" />
        <Skeleton className="mt-3 h-5 w-40" />
        <div className="mt-6 flex w-full flex-col gap-4">
          {times(5).map((i) => (
            <Skeleton key={i} className={cn("h-16 rounded-2xl", i % 2 ? "ml-auto w-3/5" : "w-4/5")} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** Centered card (auth-style and learner pages). */
export function LoadingCenteredCard({ className, wide }: { className?: string; wide?: boolean }) {
  return (
    <main className={cn("flex min-h-svh items-center justify-center p-4", className)}>
      <div className={cn("w-full space-y-4 rounded-xl border p-6", wide ? "max-w-lg" : "max-w-sm")}>
        <Skeleton className="h-6 w-1/2" />
        <Skeleton className="h-4 w-3/4" />
        <div className="space-y-3 pt-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-10 w-full rounded-lg" />
        </div>
      </div>
    </main>
  );
}
