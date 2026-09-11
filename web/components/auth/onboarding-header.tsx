"use client";

import Image from "next/image";
import { ThemeToggle } from "@/components/theme-toggle";

export function OnboardingHeader() {
  return (
    <header className="w-full bg-transparent px-8 lg:px-16 xl:px-24 pt-8 pb-4 flex items-center justify-between z-20">
      <div className="flex items-center gap-2.5 select-none">
        <Image
          src="/trainertwin-mark.svg"
          alt="TrainerTwin"
          width={22}
          height={22}
          priority
        />
        <span className="font-semibold tracking-tight text-[15px] text-foreground">
          TrainerTwin
        </span>
      </div>

      <div className="flex items-center gap-2">
        <ThemeToggle />
      </div>
    </header>
  );
}
