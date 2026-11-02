import { avatarBox, UserAvatar, type AvatarShape, type UserAvatarSize } from "@/components/user-avatar";
import type { TwinOutputs } from "@/lib/twin/trpc";
import { cn } from "@/lib/utils";

type Face = TwinOutputs["agents"]["list"]["twins"][number]["face"];

/**
 * The twin's face: its AI avatar (image, or a looping video) when one is configured on its persona,
 * otherwise the org admin's avatar (their photo, or their initial). Sized and shaped like a UserAvatar.
 */
export function TwinFace({
  face,
  size = "xl",
  shape = "circle",
  className,
}: {
  face: Face;
  size?: UserAvatarSize;
  shape?: AvatarShape;
  /** Layout only (margins, shadow); size and shape come from the props. */
  className?: string;
}) {
  if (face.avatarUrl) {
    const box = cn("shrink-0 bg-(--tone-control) object-cover", avatarBox(size, shape), className);
    return /\.(mp4|webm|mov)(\?|$)/i.test(face.avatarUrl) ? (
      <video className={box} src={face.avatarUrl} autoPlay muted loop playsInline preload="auto" aria-hidden />
    ) : (
      // eslint-disable-next-line @next/next/no-img-element -- remote avatar URL of unknown host; next/image would need it allow-listed
      <img className={box} src={face.avatarUrl} alt="" aria-hidden />
    );
  }
  return <UserAvatar user={face.person ?? { name: "Twin" }} size={size} shape={shape} className={className} />;
}
