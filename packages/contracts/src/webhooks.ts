import { z } from 'zod';
import { readScopeSchema } from './api';

export const MAX_WEBHOOK_ENDPOINTS = 10;
/**
 * The delivery window a new endpoint gets: 7 days. The single source for create, the docs and the migration that gave
 * existing endpoints this value (a test checks the migration against it).
 */
export const DEFAULT_WEBHOOK_DELIVERY_WINDOW_SECONDS = 604_800;
export const MIN_WEBHOOK_DELIVERY_WINDOW_SECONDS = 3600;
/** 3,650 days: the oldest occurrence time ingest accepts. */
export const MAX_WEBHOOK_DELIVERY_WINDOW_SECONDS = 315_360_000;
export const webhookDeliveryWindowSchema = z
  .number()
  .int()
  .min(MIN_WEBHOOK_DELIVERY_WINDOW_SECONDS)
  .max(MAX_WEBHOOK_DELIVERY_WINDOW_SECONDS)
  .multipleOf(3600)
  .nullable()
  .describe(
    'Deliver an event only if it arrived no later than this many seconds after it occurred (receivedAt − occurredAt). ' +
      'A whole number of hours, from 1 hour to 3,650 days; null means no limit. Later events stay stored and searchable but ' +
      'are not delivered. Resends and test pings ignore the window. A change applies to events discovered after the save.',
  );
export const webhookScopeSchema = z
  .object({
    tenantId: readScopeSchema.shape.tenantId.optional(),
    target: readScopeSchema.shape.target,
    mask: readScopeSchema.shape.mask,
  })
  .strict()
  .refine((scope) => scope.tenantId !== undefined || scope.target !== undefined, 'A scope needs a tenantId or a target; use null for none.');
export type WebhookScope = z.infer<typeof webhookScopeSchema>;

// Keep legacy IDs readable in endpoint responses so an admin can see and correct the stored scope.
const webhookScopeResponseSchema = z.object({
  tenantId: z.string().optional(),
  target: z.object({ type: z.string(), id: z.string() }).optional(),
  mask: readScopeSchema.shape.mask,
});

export function webhookScopeFromColumns(endpoint: {
  scopeTenantId: string | null;
  scopeTargetType: string | null;
  scopeTargetId: string | null;
  scopeMask: string[];
}) {
  const { scopeTenantId, scopeTargetType, scopeTargetId, scopeMask } = endpoint;
  const target = scopeTargetType !== null || scopeTargetId !== null ? { type: scopeTargetType, id: scopeTargetId } : undefined;
  const scope = {
    tenantId: scopeTenantId ?? undefined,
    target,
    mask: scopeMask.length ? scopeMask : undefined,
  };
  return scope.tenantId !== undefined || target || scope.mask ? scope : null;
}

export function storedWebhookScope(endpoint: Parameters<typeof webhookScopeFromColumns>[0]): WebhookScope | null | undefined {
  const scope = webhookScopeFromColumns(endpoint);
  return scope === null ? null : webhookScopeSchema.safeParse(scope).data;
}
const webhookFields = {
  url: z.string().min(1).max(2048),
  description: z.string().max(1000).nullable().optional(),
  filterQuery: z
    .string()
    .max(4096)
    .optional()
    .describe(
      'Logbird query language; empty matches every event. Regexes use RE2 syntax. In relative times such as ' +
        "occurredAt:>now-1h, now is each event's arrival time (receivedAt), so a filter selects the same events whenever discovery runs.",
    ),
  scope: webhookScopeSchema.nullable().optional(),
  enabled: z.boolean().optional(),
  /** On create, omitted means the 7-day default. On PATCH, omitted means unchanged and null removes the limit. */
  deliveryWindowSeconds: webhookDeliveryWindowSchema.optional(),
};
export const createWebhookSchema = z.object(webhookFields).strict();
/** scope replaces the entire scope; null clears it. Omission preserves it. */
export const updateWebhookSchema = createWebhookSchema.partial().refine((input) => Object.keys(input).length > 0, 'Provide at least one field.');
export const rotateWebhookSecretSchema = z.object({ overlapSeconds: z.number().int().min(0).max(604_800).default(86_400) }).strict();
export const webhookEndpointSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  url: z.string(),
  description: z.string().nullable(),
  enabled: z.boolean(),
  disabledReason: z.enum(['manual', 'gone_410', 'consecutive_failures']).nullable(),
  secretOverlapWarning: z
    .literal('webhook_secret_overlap_limit')
    .optional()
    .describe('Only the newest ten active secrets sign deliveries. Wait for an overlap to expire or rotate with overlapSeconds set to 0.'),
  scopeWarning: z.literal('webhook_invalid_scope').optional().describe('Delivery is blocked. Replace the scope with valid stored IDs and masks.'),
  filterWarning: z
    .enum(['webhook_filter_review_required', 'webhook_filter_invalid'])
    .optional()
    .describe(
      'Discovery and delivery are paused. webhook_filter_review_required: confirm a filter stored before webhook delivery. ' +
        'webhook_filter_invalid: the stored filter cannot run, for example a regex that RE2 rejects. ' +
        'Include a valid filterQuery in an endpoint PATCH to resume from the saved cursor.',
    ),
  cursorWarning: z
    .literal('webhook_cursor_review_required')
    .optional()
    .describe('Event discovery is blocked until an operator reconciles the stored cursor with rollout and delivery history.'),
  disabledAt: z.iso.datetime().nullable(),
  filterQuery: z.string(),
  scope: webhookScopeResponseSchema.nullable(),
  deliveryWindowSeconds: webhookDeliveryWindowSchema,
  lateEvents: z
    .object({
      count: z.number().int().nonnegative(),
      since: z.iso.datetime(),
    })
    .describe(
      "Events in this project that arrived later than this endpoint's window, before the endpoint's filter and scope are " +
        'applied, recorded in the whole arrival hours from `since`: the first hour boundary at or after the later of the ' +
        "endpoint's last window change and 30 days ago (the delivery log retention). It counts arrivals, so it includes late " +
        'events since removed by retention or deletion and can exceed what a search finds. After a partial storage failure ' +
        'during ingest it can be lower than the true number; it is never higher. There is no backfill: arrivals before the ' +
        'deployment added this count are not included. 0 when the window is null.',
    ),
  createdById: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const listWebhooksResponseSchema = z.object({ data: z.array(webhookEndpointSchema) });
/** The plaintext secret is returned only by create and rotate. Never persist this response. */
export const createWebhookResponseSchema = z.object({ endpoint: webhookEndpointSchema, secret: z.string() });
export const rotateWebhookSecretResponseSchema = z.object({ secret: z.string() });
export const webhookSecretOverlapLimitSchema = z.object({
  error: z.object({ code: z.literal('webhook_secret_overlap_limit'), message: z.string() }),
});
export const webhookLookupBusySchema = z.object({
  error: z.object({ code: z.literal('webhook_lookup_busy'), message: z.string() }),
});
export const webhookMutationBusySchema = z.object({
  error: z.object({ code: z.literal('webhook_mutation_busy'), message: z.string() }),
});
export const webhookUrlOrMutationBusySchema = z.union([webhookLookupBusySchema, webhookMutationBusySchema]);
export type WebhookEndpoint = z.infer<typeof webhookEndpointSchema>;

export const webhookDeliveryStatusSchema = z.enum(['pending', 'succeeded', 'failed', 'skipped']);
export const webhookAttemptSchema = z.object({
  number: z.number().int().positive(),
  status: z.enum(['sending', 'succeeded', 'failed', 'interrupted', 'skipped']),
  startedAt: z.iso.datetime(),
  latencyMs: z.number().int().nonnegative().nullable(),
  responseCode: z.number().int().nullable(),
  responseBody: z.string().nullable(),
  error: z
    .enum([
      'destination_rejected',
      'timeout',
      'network_error',
      'event_unavailable',
      'invalid_event_id',
      'lookup_failed',
      'signing_failed',
      'scope_mismatch',
    ])
    .nullable(),
});
export const webhookDeliverySchema = z.object({
  id: z.string(),
  eventId: z.string(),
  kind: z.enum(['event', 'test']),
  status: webhookDeliveryStatusSchema,
  createdAt: z.iso.datetime(),
  nextAttemptAt: z.iso.datetime().nullable(),
  attemptCount: z.number().int().nonnegative().describe('Total attempts, including attempts outside the retention window.'),
  attempts: z.array(webhookAttemptSchema).describe('The five most recent retained attempts, in attempt number order.'),
});
export const listWebhookDeliveriesQuerySchema = z.object({
  status: webhookDeliveryStatusSchema.optional(),
  cursor: z.string().min(1).max(256).optional(),
});
export const listWebhookDeliveriesResponseSchema = z.object({
  data: z.array(webhookDeliverySchema),
  nextCursor: z.string().nullable(),
});
export const queuedWebhookDeliverySchema = webhookDeliverySchema.pick({ id: true, eventId: true, kind: true, status: true }).extend({
  status: z.literal('pending'),
});
