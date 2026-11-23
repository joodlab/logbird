import { webhookSecretKey } from '@logbird/database/webhooks';

export function webhookSigningConfig({ BETTER_AUTH_SECRET, WEBHOOK_SECRET_KEY }: { BETTER_AUTH_SECRET?: string; WEBHOOK_SECRET_KEY?: string }) {
  if (!BETTER_AUTH_SECRET && !WEBHOOK_SECRET_KEY)
    return { key: null, event: 'webhook.delivery_key_missing', message: 'Set WEBHOOK_SECRET_KEY or BETTER_AUTH_SECRET to match the API.' } as const;
  try {
    return { key: webhookSecretKey(BETTER_AUTH_SECRET ?? '', WEBHOOK_SECRET_KEY || undefined) } as const;
  } catch {
    return { key: null, event: 'webhook.delivery_key_invalid', message: 'Check the API and worker webhook signing key configuration.' } as const;
  }
}
