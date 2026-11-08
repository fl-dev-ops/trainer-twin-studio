import { BASE_DOMAIN } from "@/lib/base-domain";

/** The learner role (LEARNER_ROLE in lib/org, which this client-safe module can't import). */
const LEARNER = "user";

/** A learner's org invite opens the org's home page: they sign in with Google there and join (lib/invite/accept.ts). */
export const learnerInviteUrl = (orgSlug: string) => `https://${orgSlug}.${BASE_DOMAIN}/`;

/** A studio invite (admin, team) opens the auth host's invite page, which accepts it after Google sign-in. */
export const teamInviteUrl = (invitationId: string) => `https://auth.${BASE_DOMAIN}/invite?token=${encodeURIComponent(invitationId)}`;

/** The link an org invitation's email (and Settings › Team "Copy link") points to. */
export const orgInviteUrl = (invitation: { id: string; role: string }, orgSlug: string) =>
  invitation.role === LEARNER ? learnerInviteUrl(orgSlug) : teamInviteUrl(invitation.id);
