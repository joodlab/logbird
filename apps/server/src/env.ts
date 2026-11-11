import { webhookSecretKey } from '@logbird/database/webhooks';
import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';
export const env = createEnv({
  server: {
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    REDIS_URL: z.url(),
    /** Trusted proxy hops in front of the API (false/empty = 0, true = 1); see client-address.ts. */
    TRUST_PROXY: z
      .string()
      .optional()
      .refine((v) => v === undefined || /^(true|false|\d+)?$/i.test(v.trim()), 'TRUST_PROXY must be false, true or a hop count'),
    BULLMQ_PREFIX: z.string().default('{logbird}'),
    TRUSTED_ORIGINS: z.string().default(''),
    /** Auth calls per peer; public authentication failures per peer; valid public calls per project and kind. */
    AUTH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(30),
    PUBLIC_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(600),
    INGEST_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(3000),
    READ_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(1200),
    PORT: z.coerce.number().int().min(1).max(65_535).default(4601),
    APP_URL: z.url(),
    BETTER_AUTH_SECRET: z.string().min(32),
    WEBHOOK_SECRET_KEY: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z
        .string()
        .refine((v) => {
          try {
            webhookSecretKey('', v);
            return true;
          } catch {
            return false;
          }
        }, 'WEBHOOK_SECRET_KEY must be base64 encoding of 32 bytes')
        .optional(),
    ),
    WEBHOOKS_ALLOW_HTTP: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    CLICKHOUSE_URL: z.url(),
    CLICKHOUSE_DATABASE: z.string(),
    CLICKHOUSE_USER: z.string(),
    CLICKHOUSE_PASSWORD: z.string(),
    CLICKHOUSE_QUERY_USER: z.string().optional(),
    CLICKHOUSE_QUERY_PASSWORD: z.string().optional(),
  },
  runtimeEnv: process.env,
});
