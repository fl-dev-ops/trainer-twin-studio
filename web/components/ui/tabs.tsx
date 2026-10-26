"use client"

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs"

import { cn } from "@/lib/utils"

/**
 * One look only: the pill segmented control from the twin agent page (Calibration / Sessions) —
 * a rounded sidebar-tone track with a card-coloured pill on the active tab.
 */
function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      className={cn("group/tabs flex gap-2 data-horizontal:flex-col", className)}
      {...props}
    />
  )
}

function TabsList({ className, ...props }: TabsPrimitive.List.Props) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        "inline-flex w-fit items-center rounded-full bg-(--sidebar) p-1 group-data-vertical/tabs:flex-col group-data-vertical/tabs:items-stretch group-data-vertical/tabs:rounded-[16px]",
        className
      )}
      {...props}
    />
  )
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-full px-4 py-1.5 text-[14px] leading-5 font-medium whitespace-nowrap text-muted-foreground transition-all outline-none hover:text-(--foreground)",
        "data-active:bg-card data-active:text-(--foreground) data-active:shadow-[0_1px_2px_rgb(30_28_25/0.06)]",
        "focus-visible:ring-2 focus-visible:ring-(--brand) disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    />
  )
}

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn("flex-1 text-sm outline-none", className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent }
