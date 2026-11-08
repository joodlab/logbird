import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

export const env = createEnv({
  server: {
    AUTH_LOG_SIGN_IN_CODES: z.enum(['true', 'false']).default('false'),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().default(587),
    /** true: implicit TLS from the first byte (usually port 465). */
    SMTP_SECURE: z.enum(['true', 'false']).default('false'),
    /**
     * true (with SMTP_SECURE=false): upgrade with STARTTLS before AUTH or any message data, and fail closed if the server
     * does not offer it or the upgrade fails. Use for provider port 587 (for example Postmark). Certificates are always
     * verified.
     */
    SMTP_REQUIRE_TLS: z.enum(['true', 'false']).default('false'),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    MAIL_FROM: z.string().default('Logbird <hello@logbird.local>'),
    /** Public URL of this Logbird install; every email links back to it (self-hosters get their own domain). */
    APP_URL: z.url().default('http://localhost:4600'),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
