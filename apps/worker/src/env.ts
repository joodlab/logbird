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
  },
  runtimeEnv: process.env,
});
