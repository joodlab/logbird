import {
  listWebhookDeliveriesResponseSchema,
  MAX_WEBHOOK_ENDPOINTS,
  type WebhookEndpoint,
  webhookAttemptSchema,
  webhookDeliverySchema,
} from '@logbird/contracts';
import { z } from 'zod';
import { ApiRequestError } from '@/lib/api/errors';
import { MASK_LABEL, type ScopeMask } from '@/lib/api-keys';

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
  const where = parts.length ? `Only ${parts.join(' and ')}` : 'The whole project';
  const hidden = (scope.mask ?? []).map((m) => MASK_LABEL[m as ScopeMask] ?? m);
  return hidden.length ? `${where}, hiding ${hidden.join(', ')}` : where;
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
    case 'webhook_disabled':
      return 'This endpoint is off. Turn it on first.';
    case 'webhook_invalid_scope':
      return 'This endpoint is held until its scope is corrected. Edit the scope first.';
    case 'webhook_filter_review_required':
      return 'This endpoint is held until its filter is confirmed. Confirm or edit the filter first.';
    case 'webhook_delivery_pending':
      return 'This delivery is already waiting to be sent.';
    default:
      return error.message;
  }
}

/* ---------------- the endpoint form ---------------- */

export type Form = {
  url: string;
  description: string;
  filter: string;
  tenantId: string;
  targetType: string;
  targetId: string;
  masks: ScopeMask[];
  enabled: boolean;
};
export const formFrom = (e: WebhookEndpoint | null): Form => ({
  url: e?.url ?? '',
  description: e?.description ?? '',
  filter: e?.filterQuery ?? '',
  tenantId: e?.scope?.tenantId ?? '',
  targetType: e?.scope?.target?.type ?? '',
  targetId: e?.scope?.target?.id ?? '',
  masks: (e?.scope?.mask ?? []) as ScopeMask[],
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
  if (f.masks.length && !f.tenantId.trim() && !(type && id)) e.masks = 'Hidden fields apply to a tenant or a record: name one above.';
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
            : sub === 'mask'
              ? 'masks'
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
  return {
    ...(tenantId ? { tenantId } : {}),
    ...(type && id ? { target: { type, id } } : {}),
    ...(f.masks.length ? { mask: [...f.masks].sort() } : {}),
  };
};

/* ---------------- held and warning states ---------------- */

/** Where the operator procedure lives (self-hosting docs, on GitHub). */
export const CURSOR_REVIEW_DOCS = 'https://github.com/joodlab/logbird/blob/master/docs/self-hosting.md#reconcile-a-webhook-discovery-cursor';

export type EndpointState = {
  key: 'filter' | 'scope' | 'cursor' | 'secrets';
  /** A hold pauses delivery; a warning does not. */
  kind: 'hold' | 'warning';
  badge: string;
  title: string;
  /** What happened, whether anything is lost, and what to do. */
  what: string;
  lost: string;
  todo: string;
};

/** Every state the API reports for an endpoint, holds first. A held endpoint delivers nothing and loses nothing. */
export function endpointStates(e: WebhookEndpoint): EndpointState[] {
  const states: EndpointState[] = [];
  const kept = 'It keeps its place: every event that arrives meanwhile is sent once it resumes.';
  if (e.filterWarning) {
    states.push({
      key: 'filter',
      kind: 'hold',
      badge: 'Held: confirm filter',
      title: 'Paused until someone confirms its filter',
      what: 'The query language changed in this version, and this endpoint’s filter was written for the old one. Rather than guess what it means now, Logbird paused the endpoint.',
      lost: kept,
      todo: 'Check that the filter below still selects the events you want, then confirm it, or edit it.',
    });
  }
  if (e.scopeWarning) {
    states.push({
      key: 'scope',
      kind: 'hold',
      badge: 'Held: fix scope',
      title: 'Paused until its scope is corrected',
      what: 'The stored scope names a tenant, record or hidden field this version does not accept.',
      lost: kept,
      todo: 'Edit the scope: name a tenant or record exactly as stored, or clear the scope.',
    });
  }
  if (e.cursorWarning) {
    states.push({
      key: 'cursor',
      kind: 'hold',
      badge: 'Needs an operator',
      title: 'Paused until an operator checks its position',
      what: 'Logbird found that this endpoint’s place in the event stream does not add up, so it stopped looking for new events instead of skipping or repeating any.',
      lost: kept,
      todo: 'This needs the person who runs your Logbird server: the procedure is in the self-hosting guide. There is nothing to do here.',
    });
  }
  if (e.secretOverlapWarning) {
    states.push({
      key: 'secrets',
      kind: 'warning',
      badge: 'Too many secrets',
      title: 'Only the ten newest secrets sign deliveries',
      what: 'More than ten secrets are still inside their overlap, from rotations before this version. Deliveries continue, signed with the ten newest.',
      lost: 'Nothing is paused or lost. A receiver that only knows an older secret will fail to verify.',
      todo: 'Rotate with no overlap to retire the old secrets, or wait for an overlap to end.',
    });
  }
  return states;
}

/* ---------------- delivery log ---------------- */

const ATTEMPT_ERRORS: Record<string, string> = {
  destination_rejected: 'Your endpoint answered with an error status.',
  timeout: 'Your endpoint did not answer in time.',
  network_error: 'Logbird could not connect to your endpoint.',
  event_unavailable: 'The event is no longer stored (retention), so there was nothing to send.',
  invalid_event_id: 'The event id could not be used to sign a delivery.',
  lookup_failed: 'The endpoint’s address could not be resolved, or resolved to a private address.',
  signing_failed: 'Logbird could not sign the delivery with this endpoint’s secret.',
  scope_mismatch: 'The event no longer matches the endpoint’s filter or scope, so it was skipped. This does not count as a failure.',
};

/** Why an attempt failed, in words. A code this console does not know yet still shows, as a generic error with its code. */
export function attemptErrorCopy(code: string | null): string | null {
  if (!code) return null;
  return ATTEMPT_ERRORS[code] ?? `The attempt failed (${code}).`;
}

export const DELIVERY_STATUS_LABEL: Record<string, string> = {
  pending: 'Pending',
  succeeded: 'Delivered',
  failed: 'Failed',
  skipped: 'Skipped',
};
export const ATTEMPT_STATUS_LABEL: Record<string, string> = {
  sending: 'Sending',
  succeeded: 'Delivered',
  failed: 'Failed',
  interrupted: 'Interrupted',
  skipped: 'Skipped',
};

/**
 * The delivery log, tolerant of attempt error codes this console does not know yet (the contract may add values):
 * an unknown code still renders, as a generic error with its code, instead of failing the whole page.
 */
export const lenientDeliveriesSchema = listWebhookDeliveriesResponseSchema.extend({
  data: z.array(webhookDeliverySchema.extend({ attempts: z.array(webhookAttemptSchema.extend({ error: z.string().nullable() })) })),
});
