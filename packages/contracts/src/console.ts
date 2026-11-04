import { z } from 'zod';
import { apiKeySchema, projectSchema, savedViewSchema } from './api';
import { eventSchema } from './events';

/**
 * Response envelopes for console endpoints whose shape `api.ts` left implicit.
 * Lists are always `{ data: [...] }` so they can grow pagination fields later
 * without a breaking change.
 */

export const projectListResponseSchema = z.object({ data: z.array(projectSchema) });
export type ProjectListResponse = z.infer<typeof projectListResponseSchema>;

export const apiKeyListResponseSchema = z.object({ data: z.array(apiKeySchema) });
export type ApiKeyListResponse = z.infer<typeof apiKeyListResponseSchema>;

export const savedViewListResponseSchema = z.object({ data: z.array(savedViewSchema) });
export type SavedViewListResponse = z.infer<typeof savedViewListResponseSchema>;

/** `GET /api/projects/:projectId/live?since=<iso>&q=` — events received after `since`, newest first. */
export const liveQuerySchema = z.object({
  since: z.string().optional(),
  q: z.string().max(2000).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export const liveResponseSchema = z.object({
  data: z.array(eventSchema),
  /** Server clock at response time; pass back as the next `since` to avoid client clock skew. */
  now: z.string(),
});
export type LiveResponse = z.infer<typeof liveResponseSchema>;

/** `GET /api/projects/:projectId/operations/:operationId` — every event sharing `context.operationId`, oldest first. */
export const operationResponseSchema = z.object({
  operationId: z.string(),
  events: z.array(eventSchema),
  /** True when the operation has more events than the server returns (cap: 1000). */
  truncated: z.boolean(),
});
export type OperationResponse = z.infer<typeof operationResponseSchema>;

/** `DELETE` endpoints answer with `{ ok: true }`. */
export const okResponseSchema = z.object({ ok: z.literal(true) });

/** `GET /api/projects/:projectId/retention` — what Settings → Retention shows next to the selector. */
export const retentionStatusSchema = z.object({
  retentionDays: z.number().int(),
  /** Oldest event still stored, or null when the project is empty. */
  oldestEventAt: z.string().nullable(),
  lastRun: z
    .object({
      startedAt: z.string(),
      finishedAt: z.string().nullable(),
      status: z.string(), // running | succeeded | failed
      cutoff: z.string(),
      error: z.string().nullable(),
    })
    .nullable(),
});
export type RetentionStatus = z.infer<typeof retentionStatusSchema>;
