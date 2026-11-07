import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';
import { CONTACT_EMAIL } from '../env';

const boolean = z.enum(['true', 'false']).transform((value) => value === 'true');

/** Server-only settings for the waitlist notification. Never import this from a component. */
export const serverEnv = createEnv({
  server: {
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(1025),
    SMTP_SECURE: boolean.default(false),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    MAIL_FROM: z.string().default(`Logbird <${CONTACT_EMAIL}>`),
    WAITLIST_NOTIFY_TO: z.email().default(CONTACT_EMAIL),
    /** Where the Node adapter appends submissions (PII). Default: apps/web/.data/waitlist.jsonl (gitignored). */
    WAITLIST_FILE: z.string().optional(),
    /** Extra origins allowed to post the form, comma-separated (e.g. a staging host). */
    WEB_ALLOWED_ORIGINS: z.string().optional(),
    /**
     * Reverse proxies in front of the Node server that append the client address to X-Forwarded-For (Caddy, Nginx with
     * $proxy_add_x_forwarded_for, Traefik). 0 ignores forwarding headers and limits by socket address.
     */
    WEB_TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),
  },
  isServer: true,
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
  onValidationError: () => {
    throw new Error('Invalid website server configuration. Check variable names and formats.');
  },
});
