import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { organization } from "better-auth/plugins";
import { nextCookies } from "better-auth/next-js";
import { db } from "@/lib/db";
import { BASE_DOMAIN } from "@/lib/base-domain";
import { sendInvitationEmail, sendPasswordResetEmail } from "@/lib/email";

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
