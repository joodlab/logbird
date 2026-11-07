import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

declare const __SITE_ENV__: Record<string, string | undefined> | undefined;
const publicEnv = typeof __SITE_ENV__ === 'undefined' ? process.env : __SITE_ENV__;
const boolean = z.enum(['true', 'false']).transform((value) => value === 'true');
export const env = createEnv({
  shared: {
    SITE_URL: z.url().default('https://logbird.dev'),
    APP_URL: z.url().default('https://app.logbird.dev'),
    GITHUB_URL: z.url().default('https://github.com/joodlab/logbird'),
    GITHUB_PUBLIC: boolean.default(false),
  },
  server: {
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(1025),
    SMTP_SECURE: boolean.default(false),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    MAIL_FROM: z.string().default('Logbird <hello@logbird.dev>'),
    WAITLIST_NOTIFY_TO: z.email().default('hello@logbird.dev'),
  },
  runtimeEnv: { ...(typeof process === 'undefined' ? {} : process.env), ...publicEnv },
  emptyStringAsUndefined: true,
  onValidationError: () => {
    throw new Error('Invalid website environment configuration. Check variable names and formats.');
  },
});
export const SITE_URL = env.SITE_URL.replace(/\/$/, '');
export const APP_URL = env.APP_URL;
export const GITHUB_URL = env.GITHUB_URL;
export const GITHUB_PUBLIC = env.GITHUB_PUBLIC;
export const CONTACT_EMAIL = 'hello@logbird.dev';
