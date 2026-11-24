import { describe, expect, it } from 'vitest';
import { createWebhookSchema, DEFAULT_WEBHOOK_DELIVERY_WINDOW_SECONDS, MAX_WEBHOOK_DELIVERY_WINDOW_SECONDS, updateWebhookSchema } from './webhooks';

describe('webhook delivery window', () => {
  it('accepts whole hours from 1 hour to 3,650 days, or null', () => {
    for (const deliveryWindowSeconds of [3600, 7200, DEFAULT_WEBHOOK_DELIVERY_WINDOW_SECONDS, MAX_WEBHOOK_DELIVERY_WINDOW_SECONDS, null])
      expect(createWebhookSchema.safeParse({ url: 'https://example.invalid/hook', deliveryWindowSeconds }).success).toBe(true);
    for (const deliveryWindowSeconds of [0, 1800, 3599, 5400, MAX_WEBHOOK_DELIVERY_WINDOW_SECONDS + 3600, -3600, 3600.5, '3600'])
      expect(createWebhookSchema.safeParse({ url: 'https://example.invalid/hook', deliveryWindowSeconds }).success).toBe(false);
    expect(updateWebhookSchema.safeParse({ deliveryWindowSeconds: null }).success).toBe(true);
  });
});
