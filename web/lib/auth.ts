import { apiKey } from "@better-auth/api-key";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { expireCookie } from "better-auth/cookies";
import { emailOTP, organization } from "better-auth/plugins";
import { organizationAccess, organizationRoles } from "@/lib/auth-roles";
import { nextCookies } from "better-auth/next-js";
import { db } from "@/lib/db";
import { BASE_DOMAIN, safeFamilyRedirect } from "@/lib/base-domain";
import { sendOtpEmail } from "@/lib/email";
import { AppError, refusals, toAPIError } from "@/lib/errors";
import { isDisabledUser } from "@/lib/members";
import { googleProfile, isPlaceholderName } from "@/lib/user-name";


/**
 * After a Google sign-in links or refreshes its account: give the user Google's name (and photo, if they have none)
 * while their name still matches the placeholder made from their email (lib/user-name.ts).
 * Runs on every Google sign-in, so people added before this existed are fixed the next time they sign in.
 * Never blocks the sign-in.
 */
export async function fillNameFromGoogle(account: { id?: string; providerId?: string; userId?: string; idToken?: string | null }) {
  try {
    const row = account.providerId && account.userId && account.idToken !== undefined
      ? account
      : account.id ? await db.account.findUnique({ where: { id: account.id }, select: { providerId: true, userId: true, idToken: true } }) : null;
    if (row?.providerId !== "google" || !row.userId) return;
    const profile = googleProfile(row.idToken);
    if (!profile.name) return;
    const user = await db.user.findUnique({ where: { id: row.userId }, select: { name: true, email: true, image: true } });
    if (!user || !isPlaceholderName(user.name, user.email)) return;
    await db.user.updateMany({
      where: { id: row.userId, name: user.name, email: user.email, image: user.image },
      data: { name: profile.name, ...(!user.image && profile.picture ? { image: profile.picture } : {}) },
    });
  } catch (error) {
    console.warn("[auth] could not fill the name from Google", (error as Error).message);
  }
}

const memberActionClosed = async (): Promise<never> => {
  throw toAPIError(new AppError("member_action_closed", "Add, change and disable people from Settings.", 403));
};

export const auth = betterAuth({
  appName: "TrainerTwin",
  database: prismaAdapter(db, { provider: "postgresql" }),
  // The session is kept in a signed cookie for 5 minutes, so most requests skip the session lookup (the DB is far
  // from the functions). Studio access still re-checks the member (role, disabled) on every request (lib/org.ts).
  session: { cookieCache: { enabled: true, maxAge: 5 * 60 } },
  // Sign-in is Google or a one-time email code (specs/people.md rule 10): no passwords anywhere.
  emailAndPassword: { enabled: false },
  // …and none of the password routes Better Auth still mounts (specs/people.md rule 10).
  disabledPaths: [
    "/sign-in/email", "/sign-up/email", "/change-password", "/request-password-reset", "/reset-password", "/verify-password",
    // The email-code plugin's own password routes (it's used for sign-in codes only).
    "/forget-password/email-otp", "/email-otp/request-password-reset", "/email-otp/reset-password",
  ],
  socialProviders: process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
    ? {
        google: {
          clientId: process.env.GOOGLE_CLIENT_ID,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          disableSignUp: true,
          // Sign-in must not adopt scopes the user granted to the Drive/YouTube connectors (same OAuth client):
          // their combination is rejected by Google ("scopes that cannot be requested together").
          includeGrantedScopes: false,
        },
      }
    : {},
  hooks: {
    after: createAuthMiddleware(async (ctx) => {
      const signedIn = ctx.context.newSession?.user;
      if (ctx.path === "/callback/:id" && ctx.params?.id === "google" && signedIn && isPlaceholderName(signedIn.name, signedIn.email)) {
        // The callback cached the profile it read before the account hook ran. Let the first session read use Postgres.
        expireCookie(ctx, ctx.context.authCookies.sessionData);
        return;
      }
      if (ctx.path !== "/email-otp/send-verification-otp" || ctx.body?.type !== "sign-in") return;
      const result = ctx.context.returned;
      if (!result || typeof result !== "object" || !("success" in result) || result.success !== true || typeof ctx.body.email !== "string") return;
      // Explicit registration feedback is intentional (People rule 10); never send users to an empty code step.
      const email = ctx.body.email.toLowerCase();
      const account = await ctx.context.internalAdapter.findUserByEmail(email).catch(() => {
        throw new APIError("INTERNAL_SERVER_ERROR", { message: "Could not check this email. Try again." });
      });
      if (!account) {
        if (process.env.NODE_ENV === "development") console.info(`[Dev sign-in] No local account found for this email: ${email}`);
        throw new APIError("NOT_FOUND", { code: "USER_NOT_FOUND", message: "This email isn't on TrainerTwin. Ask your trainer to add you." });
      }
    }),
  },
  databaseHooks: {
    account: {
      create: { after: (account) => fillNameFromGoogle(account) },
      update: { after: (account) => fillNameFromGoogle(account) },
    },
    session: {
      create: {
        // Disabled members cannot sign in (any method); disabling also deletes their open sessions.
        before: async (session) => {
          if (await isDisabledUser(session.userId)) throw toAPIError(refusals.memberDisabled());
        },
      },
    },
  },
  // Google refusals without our own error URL land on the sign-in page (it explains them), not Better Auth's page.
  onAPIError: { errorURL: `https://auth.${BASE_DOMAIN}/sign-in` },
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
      // People are added, disabled and changed only through lib/org-people.ts and lib/members.ts (specs/people.md
      // rules 6, 17–19), never through Better Auth's member actions, even from server code. (Leaving runs no hook;
      // its route is closed in app/api/auth/[...all]/route.ts.)
      organizationHooks: {
        beforeCreateInvitation: memberActionClosed,
        beforeAddMember: memberActionClosed,
        beforeUpdateMemberRole: memberActionClosed,
        beforeRemoveMember: memberActionClosed,
      },
    }),
    emailOTP({
      disableSignUp: true,
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
