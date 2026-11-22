import { MAX_WEBHOOK_ENDPOINTS, type WebhookEndpoint } from '@logbird/contracts';
import { ApiRequestError } from '@/lib/api/errors';

export { MAX_WEBHOOK_ENDPOINTS };

/** Why an endpoint is off, in the reader's words: who or what turned it off, and what turning it back on does. */
export function disabledCopy(reason: WebhookEndpoint['disabledReason']): { title: string; detail: string } {
  switch (reason) {
    case 'gone_410':
      return {
        title: 'Turned off: the endpoint answered 410 Gone',
        detail: 'The receiver said this URL no longer exists. Point it at a live URL, then turn it back on.',
      };
    case 'consecutive_failures':
      return {
        title: 'Turned off after repeated failed deliveries',
        detail: 'Every attempt failed for too long. Fix the receiver, then turn it back on: delivery resumes where it stopped.',
      };
    default:
      return { title: 'Turned off', detail: 'Someone turned this endpoint off. Turning it back on resumes delivery where it stopped.' };
  }
}

/** One line for an endpoint's scope: what part of the project it receives. */
export function scopeSummary(scope: WebhookEndpoint['scope']): string {
  if (!scope) return 'The whole project';
  const parts: string[] = [];
  if (scope.tenantId) parts.push(`tenant ${scope.tenantId}`);
  if (scope.target) parts.push(`record ${scope.target.type}:${scope.target.id}`);
  return parts.length ? `Only ${parts.join(' and ')}` : 'The whole project';
}

/** The URL as people recognise it: host and path. The full URL (it can carry a token) shows only in the editor. */
export function displayUrl(url: string): { host: string; path: string } {
  try {
    const u = new URL(url);
    return { host: u.host, path: `${u.pathname === '/' ? '' : u.pathname}${u.search ? '?…' : ''}` };
  } catch {
    return { host: url, path: '' };
  }
}

/** Overlap windows offered when rotating a secret (seconds); the API takes 0 to 604,800 and defaults to a day. */
export const OVERLAP_CHOICES = [
  { seconds: 0, label: 'No overlap', detail: 'The old secret stops signing now. Use it if the old secret leaked.' },
  { seconds: 3_600, label: '1 hour', detail: 'Enough to deploy a receiver that already reads the new secret.' },
  { seconds: 86_400, label: '24 hours', detail: 'Recommended. Both secrets sign deliveries for a day while you deploy.' },
  { seconds: 604_800, label: '7 days', detail: 'The longest overlap: for receivers you cannot redeploy quickly.' },
] as const;

/** Busy answers the API asks to retry (`Retry-After`): the DNS check or the endpoint lock had no capacity. */
export const isWebhookBusy = (error: unknown): error is ApiRequestError =>
  error instanceof ApiRequestError && error.status === 503 && (error.code === 'webhook_lookup_busy' || error.code === 'webhook_mutation_busy');

/** Retry a busy answer up to three times, waiting what the server asked for (default 3 s). */
export const webhookRetry = {
  retry: (failures: number, error: unknown) => isWebhookBusy(error) && failures < 3,
  retryDelay: (_failures: number, error: unknown) => ((isWebhookBusy(error) && error.retryAfter) || 3) * 1000,
};

/** What went wrong, in words, for errors the endpoint forms can meet. */
export function webhookErrorCopy(error: unknown): string {
  if (!(error instanceof ApiRequestError)) return 'Something went wrong. Try again.';
  switch (error.code) {
    case 'webhook_url_not_allowed':
      return `${error.message} Use an https URL whose host resolves to public addresses.`;
    case 'webhook_limit_reached':
      return `This project already has ${MAX_WEBHOOK_ENDPOINTS} endpoints, the most it can have. Delete one first.`;
    case 'webhook_lookup_busy':
      return 'Checking the URL took too long, so nothing was saved. Try again in a few seconds.';
    case 'webhook_mutation_busy':
      return 'Another change to this endpoint was being saved, so nothing was saved. Try again in a few seconds.';
    case 'webhook_secret_overlap_limit':
      return 'This endpoint already has ten secrets signing deliveries. Rotate with no overlap, or wait for an overlap to end.';
    case 'invalid_query':
      return `The filter is not valid: ${error.message}`;
    default:
      return error.message;
  }
}
