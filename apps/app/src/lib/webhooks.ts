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
        detail:
          'The receiver said this URL no longer exists. Nothing is sent while it is off. Point it at a live URL, then turn it back on: it resumes where it stopped.',
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
export function webhookErrorCopy(error: unknown, endpoint?: Pick<WebhookEndpoint, 'filterWarning'>): string {
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
    // One code for both filter holds: the endpoint says which. When the endpoint on screen shows no filter hold yet,
    // the hold is newer than the page: say so without guessing which one (the card refreshes and shows it).
    case 'webhook_filter_review_required':
      if (endpoint?.filterWarning === 'webhook_filter_invalid') return 'This endpoint is held because its filter cannot run. Edit the filter first.';
      if (endpoint?.filterWarning === 'webhook_filter_review_required')
        return 'This endpoint is held until its filter is confirmed. Confirm or edit the filter first.';
      return 'This endpoint was just paused because of its filter. Its card now says what to do.';
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

/**
 * The PATCH body for an edited endpoint: only what changed (a changed URL is checked again, an unchanged one is not).
 * A held scope always sends the chosen scope, even when it reads the same or is empty: that is how it is repaired. A
 * filter that cannot run always sends the filter, so saving it unchanged shows the server's reason beside it instead of
 * closing with nothing saved.
 */
export function endpointPatch(target: WebhookEndpoint, f: Form, scope: ReturnType<typeof scopeOf>): Record<string, unknown> {
  const before = formFrom(target);
  const body: Record<string, unknown> = {};
  if (f.url.trim() !== before.url) body.url = f.url.trim();
  if (f.description.trim() !== before.description) body.description = f.description.trim() || null;
  if (f.filter.trim() !== before.filter || target.filterWarning === 'webhook_filter_invalid') body.filterQuery = f.filter.trim();
  // Compared with the scope as stored (not trimmed).
  if (target.scopeWarning || JSON.stringify(scope) !== JSON.stringify(storedScope(target))) body.scope = scope;
  if (f.enabled !== before.enabled) body.enabled = f.enabled;
  return body;
}

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
/**
 * Whether the API refused a test ping or a resend because of a hold or the endpoint being off. The endpoint on screen
 * may be older than that state, so the caller refreshes it: the card then shows the hold and what to do.
 */
export function isHoldRefusal(error: unknown): boolean {
  return (
    error instanceof ApiRequestError &&
    (error.code === 'webhook_filter_review_required' || error.code === 'webhook_invalid_scope' || error.code === 'webhook_disabled')
  );
}

export const CURSOR_REVIEW_DOCS = 'https://github.com/joodlab/logbird/blob/master/docs/self-hosting.md#reconcile-a-webhook-discovery-cursor';

/**
 * Why the API would refuse to send a delivery again (or a test ping) right now, naming every step still needed:
 * fixing one hold alone leaves the others in force. Null when nothing stands in the way (a cursor review does not).
 */
export function sendBlockedCopy(
  e: Pick<WebhookEndpoint, 'enabled' | 'filterWarning' | 'scopeWarning'>,
  what: 'send a delivery again' | 'send a test ping',
): string | null {
  const steps = [
    ...(e.enabled ? [] : ['turn this endpoint on']),
    ...(e.filterWarning === 'webhook_filter_invalid' ? ['fix its filter'] : e.filterWarning ? ['confirm its filter'] : []),
    ...(e.scopeWarning ? ['fix its scope'] : []),
  ];
  if (!steps.length) return null;
  const list = steps.length === 1 ? steps[0] : `${steps.slice(0, -1).join(', ')} and ${steps.at(-1)}`;
  return `To ${what}, ${list}.`;
}

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

/**
 * Which resent deliveries have settled, from a read of the endpoint's pending deliveries: a resend is settled once it
 * is no longer pending. Only a read that *started* after a resend was queued can say so: one already in flight may
 * predate it and simply not list it yet. When the pending list has more pages than were read, a resend missing from
 * the first page is not known to be settled yet, so it stays watched.
 */
export function settledResends(
  watching: ReadonlyMap<string, number>,
  pending: { ids: readonly string[]; complete: boolean; startedAt: number },
): string[] {
  if (!pending.complete) return [];
  const stillPending = new Set(pending.ids);
  return [...watching].filter(([id, queuedAt]) => queuedAt < pending.startedAt && !stillPending.has(id)).map(([id]) => id);
}

/** Every state the API reports for an endpoint, holds first. A held endpoint delivers nothing and loses nothing. */
export function endpointStates(e: WebhookEndpoint): EndpointState[] {
  const states: EndpointState[] = [];
  // A filter or scope hold stops sending altogether; a cursor review alone stops only the search for new events.
  const blocked = Boolean(e.filterWarning || e.scopeWarning);
  const kept =
    'Nothing is sent while it is held, and nothing is skipped: it keeps its place. When it resumes, it checks the events that arrived meanwhile against its filter and scope, and sends the ones that match and are still stored.';
  if (e.filterWarning === 'webhook_filter_invalid') {
    states.push({
      key: 'filter',
      kind: 'hold',
      badge: 'Held: fix filter',
      title: 'Paused because its filter cannot run',
      what: 'The stored filter cannot be run, for example because it has a /regular expression/ the search engine does not support (patterns follow RE2: no lookarounds or backreferences). Rather than skip events or send ones it cannot check, Logbird paused the endpoint.',
      lost: kept,
      todo: 'Edit the filter so it can run. Saving a working filter clears this hold.',
    });
  } else if (e.filterWarning) {
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
      // Off and held both stop every send, so the cursor review must never say sends "still go out" then.
      lost:
        e.enabled === false && blocked
          ? 'Nothing is sent while the endpoint is off and the hold above lasts, and nothing is skipped: it keeps its place. Once it is turned on and that hold is resolved, deliveries already queued, resends and test pings go out again, while the search for new events stays paused until this review is done.'
          : e.enabled === false
            ? 'Nothing is sent while the endpoint is off, and nothing is skipped: it keeps its place. Once it is turned on, deliveries already queued, resends and test pings go out again, while the search for new events stays paused until this review is done.'
            : blocked
              ? 'Nothing is sent while the hold above lasts, and nothing is skipped: it keeps its place. Once that hold is resolved, deliveries already queued, resends and test pings go out again, while the search for new events stays paused until this review is done.'
              : 'Only the search for new events is paused, and nothing is skipped: it keeps its place. Deliveries already queued, resends and test pings still go out. When it resumes, it checks the events that arrived meanwhile against its filter and scope, and sends the matches that are still stored.',
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
  destination_rejected: 'Logbird did not send it: the address no longer passes the destination check (https, public addresses only).',
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
  return Object.hasOwn(ATTEMPT_ERRORS, code) ? (ATTEMPT_ERRORS[code] as string) : `The attempt failed (${code}).`;
}

/**
 * Why an attempt did not deliver, from its error and its response code together: an answer outside 2xx is the
 * receiver's own (even with no error code), a destination rejection without an answer means nothing was sent.
 */
export function attemptWhy(
  attempt: { status: string; error: string | null; responseCode: number | null },
  /** Whether the delivery is still waiting for another try (only then is a retry promised). */
  retrying = false,
): string | null {
  if (attempt.status === 'succeeded' || attempt.status === 'sending') return null;
  const answered = attempt.responseCode !== null && (attempt.responseCode < 200 || attempt.responseCode >= 300);
  // Both facts when both happened (a receiver can send its status, then stall).
  const error = attempt.error && attempt.error !== 'destination_rejected' ? attemptErrorCopy(attempt.error) : null;
  if (answered) {
    const said = `Your endpoint answered ${attempt.responseCode}${(attempt.responseCode ?? 0) >= 500 ? ' (a server error on its side)' : ''}.`;
    return error ? `${said} ${error}` : said;
  }
  if (attempt.error) return attemptErrorCopy(attempt.error);
  if (attempt.status === 'interrupted') return `The attempt was interrupted before it finished${retrying ? '; it is tried again' : ''}.`;
  return null;
}

/** The scope exactly as stored (not trimmed), to tell whether an edit changes it. */
export function storedScope(e: WebhookEndpoint) {
  if (!e.scope) return null;
  return {
    ...(e.scope.tenantId !== undefined ? { tenantId: e.scope.tenantId } : {}),
    ...(e.scope.target ? { target: { type: e.scope.target.type, id: e.scope.target.id } } : {}),
    ...(e.scope.mask?.length ? { mask: [...e.scope.mask].sort() } : {}),
  };
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
