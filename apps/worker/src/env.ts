import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';
export const env = createEnv({
  server: {
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    REDIS_URL: z.url(),
    BULLMQ_PREFIX: z
      .string()
      .refine((v) => /^\{[^{}]+\}$/.test(v))
      .default('{logbird}'),
    CLICKHOUSE_URL: z.url(),
    CLICKHOUSE_DATABASE: z.string(),
    CLICKHOUSE_USER: z.string(),
    CLICKHOUSE_PASSWORD: z.string(),
    BETTER_AUTH_SECRET: z.string().min(32).optional(),
    WEBHOOK_SECRET_KEY: z
      .string()
      .optional()
      .transform((key) => key || undefined),
    WEBHOOKS_ALLOW_HTTP: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    WEBHOOKS_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(16),
    WEBHOOKS_ENDPOINT_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
    WEBHOOKS_FAILURE_LIMIT: z.coerce.number().int().min(1).max(1000).default(50),
  },
  runtimeEnv: process.env,
});
