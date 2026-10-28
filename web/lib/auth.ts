import { apiKey } from "@better-auth/api-key";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { organization } from "better-auth/plugins";
import { organizationAccess, organizationRoles } from "@/lib/auth-roles";
import { nextCookies } from "better-auth/next-js";
import { db } from "@/lib/db";
import { BASE_DOMAIN, safeFamilyRedirect } from "@/lib/base-domain";
import { sendInvitationEmail, sendPasswordResetEmail } from "@/lib/email";
import { belongsToOtherOrg, ORG_LOCK_MESSAGE } from "@/lib/org-lock";
import { ADMIN_ROLE, assertNoSecondAdmin, DISABLED_MESSAGE, isDisabledUser, NO_REMOVAL_MESSAGE, ONE_ADMIN_MESSAGE } from "@/lib/members";

// Single-org lock: block invites/memberships for people already bound to another org.
async function assertSingleOrg(email: string, organizationId: string) {
  if (await belongsToOtherOrg(email, organizationId)) throw new APIError("FORBIDDEN", { message: ORG_LOCK_MESSAGE });
}


export const auth = betterAuth({
  appName: "TrainerTwin",
  database: prismaAdapter(db, { provider: "postgresql" }),
  // The session is kept in a signed cookie for 5 minutes, so most requests skip the session lookup (the DB is far
  // from the functions). Studio access still re-checks the member (role, disabled) on every request (lib/org.ts).
  session: { cookieCache: { enabled: true, maxAge: 5 * 60 } },
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
  socialProviders: process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
    ? { google: { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET } }
    : {},
  databaseHooks: {
    session: {
      create: {
        // Disabled members cannot sign in (any method); disabling also deletes their open sessions.
        before: async (session) => {
          if (await isDisabledUser(session.userId)) throw new APIError("FORBIDDEN", { message: DISABLED_MESSAGE });
        },
      },
    },
  },
  account: {
    accountLinking: {
      trustedProviders: ["google"],
    },
  },
  plugins: [
    organization({
      ac: organizationAccess,
      roles: organizationRoles,
      creatorRole: "admin",
      // Invite-only platform: organizations are created exclusively through the
      // founder onboarding flow, never self-serve.
      allowUserToCreateOrganization: false,
      organizationLimit: 1,
      organizationHooks: {
        beforeCreateInvitation: async ({ invitation, organization }) => {
          await assertNoSecondAdmin(invitation.role, organization.id);
          await assertSingleOrg(invitation.email, organization.id);
        },
        beforeAcceptInvitation: async ({ user, organization }) => {
          await assertSingleOrg(user.email, organization.id);
        },
        beforeAddMember: async ({ member, user, organization }) => {
          await assertNoSecondAdmin(member.role, organization.id);
          await assertSingleOrg(user.email, organization.id);
        },
        beforeUpdateMemberRole: async ({ member, newRole, organization }) => {
          if (member.role === ADMIN_ROLE) throw new APIError("FORBIDDEN", { message: ONE_ADMIN_MESSAGE });
          await assertNoSecondAdmin(newRole, organization.id);
        },
        beforeRemoveMember: async () => {
          throw new APIError("FORBIDDEN", { message: NO_REMOVAL_MESSAGE });
        },
      },
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
          scenarios: ["read"],
        },
      },
    }),
    nextCookies(),
  ],
  trustedOrigins: (request) => {
    const allowed = [`https://${BASE_DOMAIN}`, `https://*.${BASE_DOMAIN}`];
    // Family hosts may carry a local proxy port (portless).
    const origin = request?.headers?.get?.("origin");
    if (origin && safeFamilyRedirect(origin)) allowed.push(origin);
    return allowed;
  },
  advanced: {
    // One session cookie shared across dash./auth./<org>.<BASE_DOMAIN>.
    crossSubDomainCookies: { enabled: true, domain: BASE_DOMAIN },
  },
});

export type Session = typeof auth.$Infer.Session;
