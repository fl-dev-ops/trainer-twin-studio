import { createAccessControl } from "better-auth/plugins/access";
import { adminAc, defaultStatements, memberAc } from "better-auth/plugins/organization/access";

/**
 * Org roles, shared by the better-auth server and client (no server imports here).
 * admin and team run the studio with identical access (no org deletion; nothing uses it); user only practises.
 * Must match member_role_check in migration 20261027010000_org_roles and STUDIO_ROLES in lib/org.ts.
 */
export const organizationAccess = createAccessControl({
  ...defaultStatements,
  apiKey: ["create", "read", "update", "delete"],
} as const);

const studioRole = organizationAccess.newRole({ ...adminAc.statements, apiKey: ["create", "read", "update", "delete"] });

export const organizationRoles = {
  admin: studioRole,
  team: studioRole,
  user: organizationAccess.newRole({ ...memberAc.statements, apiKey: [] }),
};
