import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

export type AvatarUser = {
  name?: string | null;
  email?: string | null;
  image?: string | null;
};

const SIZES = {
  xs: "size-6 text-[10px]",
  sm: "size-7 text-[11px]",
  md: "size-8 text-xs",
  lg: "size-9 text-sm",
  xl: "size-10 text-sm",
  "2xl": "size-16 text-2xl",
  "3xl": "size-[86px] text-3xl",
} as const;

/** A face is round, or a rounded square (the twin's own face on its library and calibration pages). */
const SHAPES = {
  circle: "",
  rounded: "rounded-tt-lg after:rounded-tt-lg *:rounded-tt-lg",
} as const;

export type AvatarShape = keyof typeof SHAPES;

export type UserAvatarSize = keyof typeof SIZES;

/** The box (size and shape) an avatar takes, for media that stands in for one (a twin's video face). */
export function avatarBox(size: UserAvatarSize, shape: AvatarShape = "circle") {
  return cn(SIZES[size], shape === "circle" ? "rounded-full" : SHAPES.rounded);
}

// Opaque fills: avatars overlap in groups, so see-through tints would bleed into each other. These are identity
// colours, deliberately outside the token palette (design system decision D05: category colours stay out of it).
const TINTS = [
  "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200",
  "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200",
  "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200",
];

/** Same person → same colour everywhere: keyed by email, falling back to name. */
export function avatarTint(user: AvatarUser): string {
  const key = (user.email || user.name || "?").toLowerCase();
  let hash = 0;
  for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return TINTS[hash % TINTS.length];
}

export function avatarLabel(user: AvatarUser): string {
  return user.name?.trim() || user.email?.trim() || "Unknown user";
}

export function avatarInitial(user: AvatarUser): string {
  return avatarLabel(user).charAt(0).toUpperCase();
}

/** A person's photo, or their initial on a stable colour. Name shows on hover; decorative to screen readers unless `label`. */
export function UserAvatar({
  user,
  size = "md",
  shape = "circle",
  label = false,
  className,
}: {
  user: AvatarUser;
  size?: UserAvatarSize;
  shape?: AvatarShape;
  /** Announce the name to screen readers (off when the name is already visible next to it). */
  label?: boolean;
  className?: string;
}) {
  return (
    <Avatar
      className={cn(SIZES[size], SHAPES[shape], className)}
      title={avatarLabel(user)}
      aria-label={label ? avatarLabel(user) : undefined}
      aria-hidden={label ? undefined : true}
    >
      {user.image ? <AvatarImage src={user.image} alt="" /> : null}
      <AvatarFallback className={cn("text-[length:inherit] font-medium", avatarTint(user))}>
        {avatarInitial(user)}
      </AvatarFallback>
    </Avatar>
  );
}

/** Overlapping avatars with a "+N" chip past `max`, as on the V2 scenario cards. */
export function UserAvatarGroup({
  users,
  max = 4,
  size = "sm",
  className,
}: {
  users: AvatarUser[];
  max?: number;
  size?: UserAvatarSize;
  className?: string;
}) {
  if (!users.length) return null;
  const shown = users.slice(0, max);
  const extra = users.length - shown.length;
  return (
    <div
      role="group"
      aria-label={`${users.length} ${users.length === 1 ? "person" : "people"}: ${users.map(avatarLabel).join(", ")}`}
      className={cn("flex items-center", className)}
    >
      {shown.map((user, index) => (
        <UserAvatar
          key={user.email ?? user.name ?? index}
          user={user}
          size={size}
          // A border in the surface colour separates overlapping avatars (as in the V2 prototype).
          className={cn("border-2 border-card after:hidden", index > 0 && "-ml-2")}
        />
      ))}
      {extra > 0 ? (
        <span
          aria-hidden
          className={cn(
            // relative: Avatar roots are positioned, so the chip must be too to stack on top of them.
            "relative -ml-2 grid shrink-0 place-items-center rounded-full border-2 border-card bg-muted font-medium text-muted-foreground",
            SIZES[size],
          )}
        >
          +{extra}
        </span>
      ) : null}
    </div>
  );
}
