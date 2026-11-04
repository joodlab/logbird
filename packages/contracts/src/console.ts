import { z } from 'zod';
import { apiKeySchema, projectSchema, savedViewSchema } from './api';

/**
 * Response envelopes for console endpoints whose shape `api.ts` left implicit (matching what
 * apps/server returns). Lists are `{ data: [...] }`; `/live` and `/operations/:id` return a bare
 * `AuditEvent[]`; DELETE endpoints answer 204.
 */

export const projectListResponseSchema = z.object({ data: z.array(projectSchema) });
export type ProjectListResponse = z.infer<typeof projectListResponseSchema>;

export const apiKeyListResponseSchema = z.object({ data: z.array(apiKeySchema) });
export type ApiKeyListResponse = z.infer<typeof apiKeyListResponseSchema>;

export const savedViewListResponseSchema = z.object({ data: z.array(savedViewSchema) });
export type SavedViewListResponse = z.infer<typeof savedViewListResponseSchema>;

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
