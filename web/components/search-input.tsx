"use client";

import type { ComponentProps, ReactNode } from "react";
import { Search } from "lucide-react";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";

/**
 * A search field: the magnifier sits inside the field (input-group addon), so callers don't hand-place it. `end`: an
 * action inside the field's end (e.g. clear).
 */
export function SearchInput({ className, end, ...props }: ComponentProps<typeof InputGroupInput> & { end?: ReactNode }) {
  return (
    <InputGroup className={className}>
      <InputGroupAddon>
        <Search aria-hidden />
      </InputGroupAddon>
      <InputGroupInput type="search" {...props} />
      {end ? <InputGroupAddon align="inline-end">{end}</InputGroupAddon> : null}
    </InputGroup>
  );
}
