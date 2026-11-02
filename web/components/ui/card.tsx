import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Cards (plans/design-system-alignment.md D3). Radii step with the element, as the design system and the studio's
 * pages both do: the default card is the design system's (12px, card border, elevation-1) — cards in a grid, tiles,
 * nested panels; `size="lg"` is the studio's page panel (16px, the soft card shadow, 24px padding) — the top-level
 * cards of a detail or report page. Padding lives on the sections (CardHeader / CardContent / CardFooter).
 * `raised`: something genuinely floating (elevation-2). `interactive`: a linked card lifts to elevation-2 on hover, and nothing else changes (card hover is elevation only).
 */
function Card({
  className,
  size = "default",
  interactive = false,
  raised = false,
  ...props
}: React.ComponentProps<"div"> & { size?: "default" | "sm" | "lg"; interactive?: boolean; raised?: boolean }) {
  return (
    <div
      data-slot="card"
      data-size={size}
      className={cn(
        "group/card flex flex-col gap-(--card-spacing) overflow-hidden rounded-tt-md border border-card-border bg-card py-(--card-spacing) text-sm text-card-foreground shadow-elevation-1 [--card-spacing:--spacing(4)] has-data-[slot=card-footer]:pb-0 has-[>img:first-child]:pt-0 data-[size=lg]:rounded-tt-lg data-[size=lg]:shadow-card data-[size=lg]:[--card-spacing:--spacing(6)] data-[size=sm]:[--card-spacing:--spacing(3)] data-[size=sm]:has-data-[slot=card-footer]:pb-0 *:[img:first-child]:rounded-t-[inherit] *:[img:last-child]:rounded-b-[inherit]",
        raised && "shadow-elevation-2",
        interactive && "transition-shadow hover:shadow-elevation-2",
        className
      )}
      {...props}
    />
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "group/card-header @container/card-header grid auto-rows-min items-start gap-1 rounded-t-[inherit] px-(--card-spacing) has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-description]:grid-rows-[auto_auto] [.border-b]:pb-(--card-spacing)",
        className
      )}
      {...props}
    />
  )
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn(
        "font-heading text-base leading-snug font-medium group-data-[size=sm]/card:text-sm",
        className
      )}
      {...props}
    />
  )
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "col-start-2 row-span-2 row-start-1 self-start justify-self-end",
        className
      )}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn("px-(--card-spacing)", className)}
      {...props}
    />
  )
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn(
        "flex items-center rounded-b-[inherit] border-t bg-muted/50 p-(--card-spacing)",
        className
      )}
      {...props}
    />
  )
}

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
}
