"use client";

import Image from "next/image";
import { useVoiceAssistant } from "@livekit/components-react";
import { cn } from "@/lib/utils";
import { NameWave } from "./name-wave";

/** The trainer's tile. Render this only for an agent participant who is already in the room; the name is theirs. */
export function AgentTile({ persona, name: displayName, photoUrl = null, compact = false }: { persona: string; name?: string; photoUrl?: string | null; compact?: boolean }) {
  const { state } = useVoiceAssistant();
  const tone = state === "speaking" ? "speaking" : state === "thinking" ? "thinking" : "listening";

  const name = displayName?.trim() || persona.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) || "Trainer";

  return (
    <div
      className={cn(
        "relative size-full overflow-hidden rounded-2xl bg-art-pastel",
      )}
    >
      {photoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- presigned S3 link to the persona's avatar photo
        <img src={photoUrl} alt="" className="absolute inset-0 size-full object-cover object-[center_20%]" />
      ) : persona.toLowerCase() === "vasanth" ? (
        <Image src="/vasanth.png" alt="" fill sizes={compact ? "220px" : "360px"} className="object-cover" priority />
      ) : (
        <div aria-hidden className="grid size-full place-items-center">
          <span
            className={cn(
              "grid place-items-center rounded-full bg-white/70 font-semibold text-night/75",
              compact ? "size-14 text-2xl" : "size-24 text-4xl",
            )}
          >
            {name.charAt(0)}
          </span>
        </div>
      )}

      <span className="absolute right-4 bottom-4 flex max-w-[calc(100%-2rem)] items-center truncate rounded-full bg-black/55 px-3 py-1.5 text-xs font-medium text-white backdrop-blur-sm">
        <NameWave tone={tone} />
        <span className="truncate">{name}</span>
      </span>
    </div>
  );
}
