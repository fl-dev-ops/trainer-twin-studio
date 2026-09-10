"use client";

import * as React from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { X } from "lucide-react";

export function PreviewWrapper({
  open,
  onOpenChange,
  title,
  icon,
  actions,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop
          className="fixed inset-0 z-50 bg-black/70 backdrop-blur-md transition-opacity duration-150 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
        />
        <DialogPrimitive.Popup
          className="fixed inset-0 z-50 w-svw h-svh p-0 m-0 border-0 outline-none flex flex-col select-none overflow-hidden"
        >
          {/* Top Bar: Icon + File Name on Left, Actions + Close on Right */}
          <header className="flex shrink-0 items-center justify-between px-6 py-4 z-20">
            {/* Top Left: Icon + File Name */}
            <div className="flex items-center gap-3 min-w-0 pr-4">
              {icon && <span className="shrink-0 text-white/80">{icon}</span>}
              <DialogPrimitive.Title className="truncate text-sm font-medium text-white/95 tracking-tight">
                {title}
              </DialogPrimitive.Title>
            </div>

            {/* Top Right: Custom Actions + Close Button */}
            <div className="flex items-center gap-2 shrink-0">
              {actions}
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="size-9 rounded-full flex items-center justify-center text-white/75 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
                aria-label="Close"
              >
                <X className="size-5" />
              </button>
            </div>
          </header>

          {/* Centered Preview Canvas: lg:w-3/5, md:w-full, full height with 4-side margins/padding */}
          <main className="flex-1 min-h-0 w-full flex items-center justify-center p-4 sm:p-6 md:p-8 overflow-hidden z-10">
            <div className="w-full md:w-full lg:w-3/5 h-full flex items-center justify-center overflow-hidden">
              {children}
            </div>
          </main>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
