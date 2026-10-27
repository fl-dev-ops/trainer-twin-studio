import { UserAvatar } from "@/components/user-avatar";
import type { TwinOutputs } from "@/lib/twin/trpc";
import { cn } from "@/lib/utils";

type Face = TwinOutputs["agents"]["list"]["twins"][number]["face"];

/**
 * The twin's face: its AI avatar (image, or a looping video) when one is configured on its persona,
 * otherwise the org admin's avatar (their photo, or their initial). `className` sets the size; a non-round shape must
 * also round the avatar's border overlay and contents (after:/*: variants), which default to a circle.
 */
export function TwinFace({ face, className }: { face: Face; className: string }) {
  if (face.avatarUrl) {
    return /\.(mp4|webm|mov)(\?|$)/i.test(face.avatarUrl) ? (
      <video className={cn("shrink-0 bg-(--tone-control) object-cover", className)} src={face.avatarUrl} autoPlay muted loop playsInline preload="auto" aria-hidden />
    ) : (
      // eslint-disable-next-line @next/next/no-img-element -- remote avatar URL of unknown host; next/image would need it allow-listed
      <img className={cn("shrink-0 bg-(--tone-control) object-cover", className)} src={face.avatarUrl} alt="" aria-hidden />
    );
  }
  return <UserAvatar user={face.person ?? { name: "Twin" }} className={className} />;
}
