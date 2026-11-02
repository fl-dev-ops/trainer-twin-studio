import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

// Our design tokens (app/globals.css @theme). Unregistered, tailwind-merge reads e.g. `text-body-s` as a colour and
// drops it when a variant adds `text-white`, and the label falls back to the body size. Keep in sync with @theme.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["body", "body-s", "overline", "page-title", "section-title", "title-m", "title-s"],
      radius: ["tt-sm", "tt-md", "tt-lg", "stage", "portrait"],
      shadow: ["card", "elevation-1", "elevation-2", "elevation-3"],
      tracking: ["title", "overline"],
      leading: ["body", "body-s", "page-title"],
      "text-shadow": ["caption", "subtitle"],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
