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
  { seconds: 3600, label: '1 hour', detail: 'Enough to deploy a receiver that already reads the new secret.' },
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

/* ---------------- the endpoint form ---------------- */

export type Form = { url: string; description: string; filter: string; tenantId: string; targetType: string; targetId: string; enabled: boolean };
export const formFrom = (e: WebhookEndpoint | null): Form => ({
  url: e?.url ?? '',
  description: e?.description ?? '',
  filter: e?.filterQuery ?? '',
  tenantId: e?.scope?.tenantId ?? '',
  targetType: e?.scope?.target?.type ?? '',
  targetId: e?.scope?.target?.id ?? '',
  enabled: e?.enabled ?? true,
});
export type FormErrors = Partial<Record<keyof Form | 'form', string>>;

/** The contract's limits, checked before sending, on the field that breaks them. */
export function validateWebhookForm(f: Form): FormErrors {
  const e: FormErrors = {};
  const url = f.url.trim();
  if (!url) e.url = 'Enter the URL Logbird should POST to.';
  else if (!/^https?:\/\//i.test(url)) e.url = 'Start the URL with https://.';
  else if (url.length > 2048) e.url = `The URL is ${url.length.toLocaleString()} characters; the most is 2,048.`;
  if (f.description.trim().length > 1000)
    e.description = `The description is ${f.description.trim().length.toLocaleString()} characters; the most is 1,000.`;
  if (f.filter.trim().length > 4096) e.filter = `The filter is ${f.filter.trim().length.toLocaleString()} characters; the most is 4,096.`;
  for (const [field, label] of [
    ['tenantId', 'tenant id'],
    ['targetType', 'record type'],
    ['targetId', 'record id'],
  ] as const) {
    if (f[field].trim().length > 256) e[field] = `The ${label} is ${f[field].trim().length} characters; the most is 256.`;
  }
  const type = f.targetType.trim();
  const id = f.targetId.trim();
  // The missing half is the field that needs attention.
  if (type && !id) e.targetId ??= 'Add the record’s id: a record needs both its type and its id.';
  if (id && !type) e.targetType ??= 'Add the record’s type: a record needs both its type and its id.';
  return e;
}

/** Field messages from a 422 validation_error whose details name the body field (zod issues). */
export function fieldErrorsFromValidation(error: unknown): FormErrors {
  if (!(error instanceof ApiRequestError) || error.code !== 'validation_error' || !Array.isArray(error.details)) return {};
  const out: FormErrors = {};
  const map: Record<string, keyof Form> = { url: 'url', description: 'description', filterQuery: 'filter' };
  for (const issue of error.details as { path?: unknown[]; message?: string }[]) {
    const [top, sub, leaf] = issue.path ?? [];
    const field =
      top === 'scope'
        ? sub === 'tenantId'
          ? 'tenantId'
          : sub === 'target'
            ? leaf === 'type'
              ? 'targetType'
              : 'targetId'
            : 'tenantId'
        : map[String(top)];
    if (field && !out[field]) out[field] = issue.message || 'This value is not accepted.';
  }
  return out;
}

export const scopeOf = (f: Form) => {
  const tenantId = f.tenantId.trim();
  const type = f.targetType.trim();
  const id = f.targetId.trim();
  if (!tenantId && !type && !id) return null;
  return { ...(tenantId ? { tenantId } : {}), ...(type && id ? { target: { type, id } } : {}) };
};
