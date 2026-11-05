import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';
export const env = createEnv({
  server: {
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    REDIS_URL: z.url(),
    TRUST_PROXY: z.enum(['true', 'false']).default('false'),
    BULLMQ_PREFIX: z.string().default('{trailmark}'),
    TRUSTED_ORIGINS: z.string().default(''),
    PORT: z.coerce.number().int().min(1).max(65_535).default(4601),
    APP_URL: z.url(),
    CLICKHOUSE_URL: z.url(),
    CLICKHOUSE_DATABASE: z.string(),
    CLICKHOUSE_USER: z.string(),
    CLICKHOUSE_PASSWORD: z.string(),
    CLICKHOUSE_QUERY_USER: z.string().optional(),
    CLICKHOUSE_QUERY_PASSWORD: z.string().optional(),
  },
  runtimeEnv: process.env,
});
