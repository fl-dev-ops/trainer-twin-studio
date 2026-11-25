import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "relative cursor-pointer group/button inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-full border border-transparent bg-clip-padding text-base leading-5 font-semibold whitespace-nowrap transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:size-4",
  {
    variants: {
      variant: {
        default: "bg-brand text-white hover:bg-brand-hover",
        secondary: "bg-button-secondary text-foreground hover:bg-button-secondary/85 aria-expanded:bg-button-secondary/85",
        ghost: "bg-transparent text-foreground hover:bg-muted aria-expanded:not-data-[sidebar=trigger]:bg-muted",
      },
      iconOnly: {
        false: "px-[18px]",
        true: "w-9 p-0",
      },
    },
    defaultVariants: {
      variant: "default",
      iconOnly: false,
    },
  }
)

// h-11 is the sign-in actions only. Every other height override is dropped; the control stays h-9.
const layoutClass = /^(?:(?:sm|md|lg|xl|2xl):)*(?:-?m[trblxyse]?-(?:auto|\d+(?:\.5)?)|-?(?:top|right|bottom|left|inset|translate-[xy])-(?:\d+(?:\.5)?|1\/2|\[[-\d.]+%\])|(?:col|row)-(?:start-|end-|span-)?\d+|(?:self|justify-self)-(?:start|end|center|stretch)|(?:absolute|relative|fixed|sticky|hidden|block|inline-flex|flex|shrink-0|grow|w-(?:full|fit|auto)|h-11|group\/[\w-]+))$/

type ButtonProps = Omit<ButtonPrimitive.Props, "className" | "style"> &
  VariantProps<typeof buttonVariants> & { className?: string; loading?: boolean; touchTarget?: boolean }

function Button({
  className,
  variant = "default",
  iconOnly = false,
  loading = false,
  touchTarget = false,
  disabled,
  children,
  ...props
}: ButtonProps) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(
        buttonVariants({ variant, iconOnly }),
        touchTarget && "pointer-coarse:after:absolute pointer-coarse:after:inset-y-[-4px] pointer-coarse:after:inset-x-0 pointer-coarse:after:content-['']",
        className?.split(/\s+/).filter((token) => layoutClass.test(token) && (!iconOnly || !/(?:^|:)w-/.test(token)))
      )}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? (
        <>
          <svg
            className="size-4 animate-spin"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
          {children}
        </>
      ) : (
        children
      )}
    </ButtonPrimitive>
  )
}

export { Button, buttonVariants }
