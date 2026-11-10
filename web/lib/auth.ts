import { apiKey } from "@better-auth/api-key";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { emailOTP, organization } from "better-auth/plugins";
import { organizationAccess, organizationRoles } from "@/lib/auth-roles";
import { nextCookies } from "better-auth/next-js";
import { db } from "@/lib/db";
import { BASE_DOMAIN, safeFamilyRedirect } from "@/lib/base-domain";
import { sendOtpEmail } from "@/lib/email";
import { ADMIN_ROLE, assertNoSecondAdmin, DISABLED_MESSAGE, isDisabledUser, NO_REMOVAL_MESSAGE, ONE_ADMIN_MESSAGE } from "@/lib/members";


export const auth = betterAuth({
  appName: "TrainerTwin",
  database: prismaAdapter(db, { provider: "postgresql" }),
  // The session is kept in a signed cookie for 5 minutes, so most requests skip the session lookup (the DB is far
  // from the functions). Studio access still re-checks the member (role, disabled) on every request (lib/org.ts).
  session: { cookieCache: { enabled: true, maxAge: 5 * 60 } },
  // Sign-in is Google or a one-time email code (specs/people.md rule 10): no passwords anywhere.
  emailAndPassword: { enabled: false },
  socialProviders: process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
    ? {
        google: {
          clientId: process.env.GOOGLE_CLIENT_ID,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          // Sign-in must not adopt scopes the user granted to the Drive/YouTube connectors (same OAuth client):
          // their combination is rejected by Google ("scopes that cannot be requested together").
          includeGrantedScopes: false,
        },
      }
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
      // People added to an org get an account before they ever sign in (lib/org-people.ts), unverified. Google may
      // link to it: with no passwords, nobody else can hold a way into that account.
      requireLocalEmailVerified: false,
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
        // People may belong to several orgs (the studio works in one at a time: lib/org.ts).
        // People are added straight to the org (lib/org-people.ts, Settings); there are no invitations to accept.
        beforeCreateInvitation: async () => {
          throw new APIError("FORBIDDEN", { message: "Add people from Settings; they sign in and are in." });
        },
        beforeAddMember: async ({ member, organization }) => {
          await assertNoSecondAdmin(member.role, organization.id);
        },
        beforeUpdateMemberRole: async ({ member, newRole, organization }) => {
          if (member.role === ADMIN_ROLE) throw new APIError("FORBIDDEN", { message: ONE_ADMIN_MESSAGE });
          await assertNoSecondAdmin(newRole, organization.id);
        },
        beforeRemoveMember: async () => {
          throw new APIError("FORBIDDEN", { message: NO_REMOVAL_MESSAGE });
        },
      },
    }),
    emailOTP({
      otpLength: 6,
      expiresIn: 10 * 60,
      allowedAttempts: 3,
      storeOTP: "hashed",
      sendVerificationOTP: async ({ email, otp, type }) => {
        if (type !== "sign-in") return; // only sign-in codes are used
        const result = await sendOtpEmail({ to: email, otp });
        if (!result.success) throw new APIError("INTERNAL_SERVER_ERROR", { message: "Could not send the code. Try again, or use Google." });
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
