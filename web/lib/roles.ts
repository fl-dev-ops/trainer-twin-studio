/**
 * Org roles on `member.role` (one per member; CHECK member_role_check, migration 20261027010000_org_roles): admin and
 * team run the studio with the same access; user ("learner") only practises. One admin per org (specs/people.md).
 * No imports: client code may use it.
 */
export const ADMIN_ROLE = "admin";
export const TEAM_ROLE = "team";
export const LEARNER_ROLE = "user";
export const STUDIO_ROLES = [ADMIN_ROLE, TEAM_ROLE] as const;
export type OrgRole = (typeof STUDIO_ROLES)[number] | typeof LEARNER_ROLE;
export const isStudioRole = (role: string | null | undefined) => role === ADMIN_ROLE || role === TEAM_ROLE;
