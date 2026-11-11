import { z } from 'zod';

export const MAX_WEBHOOK_ENDPOINTS = 10;
export const webhookScopeSchema = z
  .object({
    tenantId: z.string().min(1).max(256).optional(),
    target: z
      .object({ type: z.string().min(1).max(256), id: z.string().min(1).max(256) })
      .strict()
      .optional(),
  })
  .strict();
const webhookFields = {
  url: z.string().min(1).max(2048),
  description: z.string().max(1000).nullable().optional(),
  filterQuery: z.string().max(4096).optional(),
  scope: webhookScopeSchema.nullable().optional(),
  enabled: z.boolean().optional(),
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
  disabledAt: z.iso.datetime().nullable(),
  filterQuery: z.string(),
  scope: webhookScopeSchema.nullable(),
  createdById: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const listWebhooksResponseSchema = z.object({ data: z.array(webhookEndpointSchema) });
/** The plaintext secret is returned only by create and rotate. Never persist this response. */
export const createWebhookResponseSchema = z.object({ endpoint: webhookEndpointSchema, secret: z.string() });
export const rotateWebhookSecretResponseSchema = z.object({ secret: z.string() });
export type WebhookEndpoint = z.infer<typeof webhookEndpointSchema>;
