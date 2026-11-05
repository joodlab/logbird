import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

export const env = createEnv({
  server: {
    SMTP_HOST: z.string().default('127.0.0.1'),
    SMTP_PORT: z.coerce.number().default(1025),
    SMTP_SECURE: z.enum(['true', 'false']).default('false'),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    MAIL_FROM: z.string().default('Trailmark <hello@trailmark.local>'),
    /** Public URL of this Trailmark install; every email links back to it (self-hosters get their own domain). */
    APP_URL: z.url().default('http://localhost:4600'),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
