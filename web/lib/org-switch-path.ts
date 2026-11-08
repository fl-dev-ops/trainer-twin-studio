// Fixed second-level-and-deeper segments of the studio's routes (app/dash/**); any other segment is a record id or slug.
// shortcut: mirrors app/dash by hand, add a segment here when a new static sub-page (like /twin/brain) is added.
const STATIC_SEGMENTS = new Set(["avatar", "brain", "cloning", "fidelity", "knowledge", "new", "review", "sessions", "settings", "users", "voice"]);

/**
 * Where to land after switching org: the same page, unless it shows one record (a user, twin, session…) that won't
 * exist in the other org; then that section's list (`/users/abc` → `/users`, `/twin/sessions/x` → `/twin/sessions`).
 */
export function pathAfterOrgSwitch(pathname: string, search: string): string {
  const segments = pathname.split("/").filter(Boolean);
  const recordAt = segments.findIndex((segment, index) => index > 0 && !STATIC_SEGMENTS.has(segment));
  if (recordAt === -1) return `/${segments.join("/")}${search}`;
  return `/${segments.slice(0, recordAt).join("/")}`;
}
