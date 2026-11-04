import { createEnv } from '@t3-oss/env-core';
import { prisma } from '@trailmark/database';
import { sendOrganizationInvitation, sendSignInCode } from '@trailmark/email';
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { emailOTP, organization } from 'better-auth/plugins';
import { z } from 'zod';

const env = createEnv({ server: { APP_URL: z.url(), BETTER_AUTH_SECRET: z.string().min(32) }, runtimeEnv: process.env });
export const auth = betterAuth({
  baseURL: env.APP_URL,
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: [env.APP_URL],
  database: prismaAdapter(prisma, { provider: 'postgresql' }),
  advanced: { useSecureCookies: new URL(env.APP_URL).protocol === 'https:', defaultCookieAttributes: { httpOnly: true, sameSite: 'lax' } },
  plugins: [
    emailOTP({
      otpLength: 6,
      storeOTP: 'hashed',
      expiresIn: 600,
      disableSignUp: false,
      async sendVerificationOTP({ email, otp }) {
        await sendSignInCode(email, otp);
      },
    }),
    organization({
      async sendInvitationEmail(data) {
        await sendOrganizationInvitation(data.email, data.organization.name, `${env.APP_URL}/accept-invitation/${data.id}`);
      },
    }),
  ],
});
export type AuthSession = typeof auth.$Infer.Session;
