import { apiKey } from "@better-auth/api-key";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { organization } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { adminAc, defaultStatements, memberAc, ownerAc } from "better-auth/plugins/organization/access";
import { nextCookies } from "better-auth/next-js";
import { db } from "@/lib/db";
import { BASE_DOMAIN } from "@/lib/base-domain";
import { sendInvitationEmail, sendPasswordResetEmail } from "@/lib/email";

const organizationAccess = createAccessControl({
  ...defaultStatements,
  apiKey: ["create", "read", "update", "delete"],
} as const);
const organizationRoles = {
  owner: organizationAccess.newRole({ ...ownerAc.statements, apiKey: ["create", "read", "update", "delete"] }),
  admin: organizationAccess.newRole({ ...adminAc.statements, apiKey: ["create", "read", "update", "delete"] }),
  member: organizationAccess.newRole({ ...memberAc.statements, apiKey: [] }),
};

export const auth = betterAuth({
  appName: "TrainerTwin",
  database: prismaAdapter(db, { provider: "postgresql" }),
  emailAndPassword: {
    enabled: true,
    sendResetPassword: async (data) => {
      await sendPasswordResetEmail({
        to: data.user.email,
        resetUrl: data.url,
        userName: data.user.name,
      });
    },
  },
  plugins: [
    organization({
      ac: organizationAccess,
      roles: organizationRoles,
      // Invite-only platform: organizations are created exclusively through the
      // founder onboarding flow, never self-serve.
      allowUserToCreateOrganization: false,
      organizationLimit: 1,
      sendInvitationEmail: async (data) => {
        const inviteLink = `https://auth.${BASE_DOMAIN}/invite?token=${data.id}`;
        const inviterName =
          (data.inviter as { user?: { name?: string; email?: string } })?.user
            ?.name ||
          (data.inviter as { name?: string })?.name ||
          "Your team";

        await sendInvitationEmail({
          to: data.email,
          organizationName: data.organization.name,
          inviterName,
          inviteUrl: inviteLink,
        });
      },
    }),
    apiKey({
      references: "organization",
      defaultPrefix: "tt_",
      defaultKeyLength: 64,
      requireName: true,
      maximumNameLength: 60,
      enableMetadata: true,
      keyExpiration: {
        defaultExpiresIn: 60 * 60 * 24 * 365,
        disableCustomExpiresTime: true,
      },
      rateLimit: { enabled: true, timeWindow: 60_000, maxRequests: 120 },
      permissions: {
        defaultPermissions: {
          users: ["read", "write"],
          sessions: ["read", "write"],
          assignments: ["read", "write"],
        },
      },
    }),
    nextCookies(),
  ],
  trustedOrigins: (request) => {
    const allowed = [`https://${BASE_DOMAIN}`, `https://*.${BASE_DOMAIN}`];
    // Family hosts may carry a local proxy port (portless); trust the caller's
    // own origin (browsers cannot forge Origin, so this stays safe).
    const origin = request?.headers?.get?.("origin");
    if (origin?.includes(BASE_DOMAIN)) {
      allowed.push(origin);
    }
    return allowed;
  },
  advanced: {
    // One session cookie shared across dash./auth./<org>.<BASE_DOMAIN>.
    crossSubDomainCookies: { enabled: true, domain: BASE_DOMAIN },
  },
});

export type Session = typeof auth.$Infer.Session;
