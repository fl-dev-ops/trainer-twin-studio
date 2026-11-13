import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"

import { cn } from "@/lib/utils"

/** Shared by text inputs and OTP cells so auth and Settings use the same control treatment. */
const inputControlStyles = "h-8 rounded-lg border border-input bg-transparent text-base transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40"

function Input({
  className,
  type,
  size,
  ...props
}: Omit<React.ComponentProps<"input">, "size"> & { size?: "default" | "sm" | number }) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        inputControlStyles,
        "w-full min-w-0 px-2.5 py-1 file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground",
        size === "sm" && "h-7 rounded-md px-2 text-xs",
        className
      )}
      {...props}
    />
  )
}

export { Input, inputControlStyles }
