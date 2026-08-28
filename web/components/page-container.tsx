import type { ComponentProps } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const pageContainerVariants = cva("mx-auto w-full", {
  variants: {
    size: {
      narrow: "max-w-4xl",
      wide: "max-w-none",
    },
  },
  defaultVariants: {
    size: "narrow",
  },
});

export function PageContainer({
  className,
  size,
  ...props
}: ComponentProps<"div"> & VariantProps<typeof pageContainerVariants>) {
  return (
    <div
      data-slot="page-container"
      data-size={size ?? "narrow"}
      className={cn(pageContainerVariants({ size }), className)}
      {...props}
    />
  );
}
