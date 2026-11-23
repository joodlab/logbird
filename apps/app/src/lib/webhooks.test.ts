import { CONSOLE_ROUTES, type WebhookEndpoint } from '@logbird/contracts';
import { createRouter } from '@tanstack/react-router';
import { describe, expect, it } from 'vitest';
import { routeTree } from '@/routeTree.gen';
import { ApiRequestError } from './api/errors';
import {
  attemptErrorCopy,
  attemptWhy,
  disabledCopy,
  displayUrl,
  endpointStates,
  type Form,
  fieldErrorsFromValidation,
  formFrom,
  isWebhookBusy,
  lenientDeliveriesSchema,
  scopeOf,
  scopeSummary,
  sendBlockedCopy,
  storedScope,
  validateWebhookForm,
  webhookErrorCopy,
  webhookRetry,
} from './webhooks';

/** Every path the console serves, as the router resolves them. */
function servedPaths(): string[] {
  const router = createRouter({ routeTree, context: {} as never });
  return Object.keys(router.routesByPath);
}

describe('the webhooks settings page', () => {
  it('is served at the path the filter-review email links to', () => {
    // The notice email links to /p/{projectId}/settings/webhooks (CONSOLE_ROUTES.webhookSettings once #179 lands).
    expect(servedPaths()).toContain('/p/$projectId/settings/webhooks');
  });
});

describe('webhook copy', () => {
  it('says why an endpoint is off', () => {
    expect(disabledCopy('gone_410').title).toMatch(/410 Gone/);
    expect(disabledCopy('consecutive_failures').title).toMatch(/repeated failed deliveries/);
    expect(disabledCopy('manual').title).toBe('Turned off');
    expect(disabledCopy(null).title).toBe('Turned off');
  });
  it('summarises the scope', () => {
    expect(scopeSummary(null)).toBe('The whole project');
    expect(scopeSummary({ tenantId: 'biz_7' })).toBe('Only tenant biz_7');
    expect(scopeSummary({ tenantId: 'biz_7', target: { type: 'booking', id: 'bk_1' } })).toBe('Only tenant biz_7 and record booking:bk_1');
  });
  it('shows host and path but never a query string, which can carry a token', () => {
    expect(displayUrl('https://hooks.example.com/services/T0/B0/secret?token=abc')).toEqual({
      host: 'hooks.example.com',
      path: '/services/T0/B0/secret?…',
    });
    expect(displayUrl('https://example.com/')).toEqual({ host: 'example.com', path: '' });
  });
  it('names every step still needed before anything can be sent, since fixing one hold alone leaves the others', () => {
    const e = (enabled: boolean, filter: boolean, scope: boolean) => ({
      enabled,
      filterWarning: filter ? ('webhook_filter_review_required' as const) : undefined,
      scopeWarning: scope ? ('webhook_invalid_scope' as const) : undefined,
    });
    expect(sendBlockedCopy(e(true, false, false), 'send a delivery again')).toBeNull();
    expect(sendBlockedCopy(e(false, false, false), 'send a delivery again')).toBe('To send a delivery again, turn this endpoint on.');
    expect(sendBlockedCopy(e(true, true, true), 'send a delivery again')).toBe('To send a delivery again, confirm its filter and fix its scope.');
    expect(sendBlockedCopy(e(false, true, true), 'send a test ping')).toBe(
      'To send a test ping, turn this endpoint on, confirm its filter and fix its scope.',
    );
  });
});

describe('busy answers', () => {
  const busy = new ApiRequestError(503, 'webhook_mutation_busy', 'busy', undefined, 2);
  it('retries a busy answer up to three times, after the time the server asked for', () => {
    expect(isWebhookBusy(busy)).toBe(true);
    expect(webhookRetry.retry(0, busy)).toBe(true);
    expect(webhookRetry.retry(3, busy)).toBe(false);
    expect(webhookRetry.retryDelay(1, busy)).toBe(2000);
    expect(webhookRetry.retryDelay(1, new ApiRequestError(503, 'webhook_lookup_busy', 'busy'))).toBe(3000);
  });
  it('never retries other failures', () => {
    expect(webhookRetry.retry(0, new ApiRequestError(400, 'webhook_url_not_allowed', 'no'))).toBe(false);
    expect(webhookRetry.retry(0, new Error('x'))).toBe(false);
  });
  it('explains the errors in words', () => {
    expect(webhookErrorCopy(new ApiRequestError(400, 'webhook_limit_reached', 'x'))).toMatch(/at most|already has 10/);
    expect(webhookErrorCopy(busy)).toMatch(/nothing was saved/);
  });
});

describe('the endpoint form', () => {
  const form = (patch: Partial<Form> = {}): Form => ({ ...formFrom(null), url: 'https://hooks.example.com/x', ...patch });
  it('checks the contract limits on the field that breaks them', () => {
    expect(validateWebhookForm(form())).toEqual({});
    expect(validateWebhookForm(form({ description: 'x'.repeat(1001) })).description).toMatch(/1,000/);
    expect(validateWebhookForm(form({ tenantId: 't'.repeat(257) })).tenantId).toMatch(/256/);
    expect(validateWebhookForm(form({ filter: 'a'.repeat(4097) })).filter).toMatch(/4,096/);
    expect(validateWebhookForm(form({ url: '' })).url).toMatch(/Enter the URL/);
  });
  it('marks the missing half of a record', () => {
    const idOnly = validateWebhookForm(form({ targetId: 'bk_1' }));
    expect(idOnly.targetType).toMatch(/type/);
    expect(idOnly.targetId).toBeUndefined();
    expect(validateWebhookForm(form({ targetType: 'booking' })).targetId).toMatch(/id/);
  });
  it('puts a contract rejection on its field', () => {
    const error = new ApiRequestError(422, 'validation_error', 'Invalid request body.', [
      { path: ['description'], message: 'Too big: expected string to have <=1000 characters' },
      { path: ['scope', 'target', 'type'], message: 'Too small' },
    ]);
    expect(fieldErrorsFromValidation(error)).toEqual({ description: 'Too big: expected string to have <=1000 characters', targetType: 'Too small' });
    expect(fieldErrorsFromValidation(new ApiRequestError(400, 'webhook_url_not_allowed', 'no'))).toEqual({});
  });
});

describe('webhooks after delivery (#179)', () => {
  it('is served at the route the notice email builds its link from', () => {
    expect(servedPaths()).toContain(CONSOLE_ROUTES.webhookSettings);
  });
  const endpoint = (patch: Partial<WebhookEndpoint>): WebhookEndpoint => ({
    id: 'wh_1',
    projectId: 'p',
    url: 'https://hooks.example.com/x',
    description: null,
    enabled: true,
    disabledReason: null,
    disabledAt: null,
    filterQuery: 'action:booking.*',
    scope: null,
    createdById: null,
    createdAt: '2026-11-22T10:00:00.000Z',
    updatedAt: '2026-11-22T10:00:00.000Z',
    ...patch,
  });
  it('gives every hold and warning a state that says what happened, that nothing is lost, and what to do', () => {
    const states = endpointStates(
      endpoint({
        filterWarning: 'webhook_filter_review_required',
        scopeWarning: 'webhook_invalid_scope',
        cursorWarning: 'webhook_cursor_review_required',
        secretOverlapWarning: 'webhook_secret_overlap_limit',
      }),
    );
    expect(states.map((s) => [s.key, s.kind])).toEqual([
      ['filter', 'hold'],
      ['scope', 'hold'],
      ['cursor', 'hold'],
      ['secrets', 'warning'],
    ]);
    for (const s of states) for (const text of [s.title, s.what, s.lost, s.todo]) expect(text.length).toBeGreaterThan(10);
    expect(states.find((s) => s.key === 'cursor')?.todo).toMatch(/nothing to do here/);
    expect(endpointStates(endpoint({}))).toEqual([]);
  });
  it('explains a filter that cannot run as its own hold: what is wrong, that nothing is sent, and that editing clears it', () => {
    const held = endpoint({ filterWarning: 'webhook_filter_invalid' });
    const [state] = endpointStates(held);
    expect(state).toMatchObject({ key: 'filter', kind: 'hold', badge: 'Held: fix filter' });
    expect(state?.what).toMatch(/cannot be run/);
    expect(state?.what).toMatch(/RE2/);
    expect(state?.lost).toMatch(/Nothing is sent while it is held/);
    expect(state?.todo).toMatch(/^Edit the filter/);
    expect(state?.todo).not.toMatch(/confirm/i);
    expect(sendBlockedCopy({ enabled: true, filterWarning: 'webhook_filter_invalid', scopeWarning: undefined }, 'send a test ping')).toBe(
      'To send a test ping, fix its filter.',
    );
    // The API answers both filter holds with one code; the endpoint says which, and so does the copy.
    const refused = new ApiRequestError(409, 'webhook_filter_review_required', 'held');
    expect(webhookErrorCopy(refused, held)).toBe('This endpoint is held because its filter cannot run. Edit the filter first.');
    expect(webhookErrorCopy(refused, endpoint({ filterWarning: 'webhook_filter_review_required' }))).toMatch(/until its filter is confirmed/);
  });
  it('renders an attempt error this console does not know as a generic error with its code', () => {
    expect(attemptErrorCopy('timeout')).toMatch(/did not answer in time/);
    expect(attemptErrorCopy('brand_new_error')).toBe('The attempt failed (brand_new_error).');
    expect(attemptErrorCopy(null)).toBeNull();
    const page = lenientDeliveriesSchema.parse({
      nextCursor: null,
      data: [
        {
          id: 'd1',
          eventId: 'e1',
          kind: 'event',
          status: 'failed',
          createdAt: '2026-11-22T10:00:00.000Z',
          nextAttemptAt: null,
          attemptCount: 1,
          attempts: [
            {
              number: 1,
              status: 'failed',
              startedAt: '2026-11-22T10:00:01.000Z',
              latencyMs: 12,
              responseCode: null,
              responseBody: null,
              error: 'brand_new_error',
            },
          ],
        },
      ],
    });
    expect(page.data[0]?.attempts[0]?.error).toBe('brand_new_error');
  });
  it('names hidden fields in the scope and needs a tenant or record for them', () => {
    expect(scopeSummary({ tenantId: 'biz_7', mask: ['ip', 'actor_email'] })).toBe('Only tenant biz_7, hiding IP address, Actor email');
    const f = { ...formFrom(null), url: 'https://hooks.example.com/x', masks: ['ip' as const] };
    expect(validateWebhookForm(f).masks).toMatch(/tenant or a record/);
    expect(validateWebhookForm({ ...f, tenantId: 'biz_7' }).masks).toBeUndefined();
    expect(scopeOf({ ...f, tenantId: 'biz_7', masks: ['user_agent', 'ip'] })).toEqual({ tenantId: 'biz_7', mask: ['ip', 'user_agent'] });
  });
});

describe('why an attempt did not deliver', () => {
  it('uses the response code and the error together', () => {
    // Refused before any HTTP: nothing was sent.
    expect(attemptWhy({ status: 'failed', error: 'destination_rejected', responseCode: null })).toMatch(/did not send it/);
    // The receiver's own answer, even without an error code.
    expect(attemptWhy({ status: 'failed', error: null, responseCode: 500 })).toBe('Your endpoint answered 500 (a server error on its side).');
    expect(attemptWhy({ status: 'failed', error: 'destination_rejected', responseCode: 404 })).toBe('Your endpoint answered 404.');
    expect(attemptWhy({ status: 'succeeded', error: null, responseCode: 200 })).toBeNull();
    expect(attemptWhy({ status: 'interrupted', error: null, responseCode: null })).toMatch(/interrupted/);
  });
  it('never mistakes an inherited name for a known code', () => {
    expect(attemptErrorCopy('toString')).toBe('The attempt failed (toString).');
    expect(attemptErrorCopy('constructor')).toBe('The attempt failed (constructor).');
  });
});

describe('scope repairs', () => {
  it('compares with the scope as stored, untrimmed', () => {
    expect(storedScope({ scope: { tenantId: ' biz_7 ', mask: ['user_agent', 'ip'] } } as never)).toEqual({
      tenantId: ' biz_7 ',
      mask: ['ip', 'user_agent'],
    });
    expect(storedScope({ scope: null } as never)).toBeNull();
  });
});

describe('attempt explanations keep every fact', () => {
  it('says both the answer and the error when both happened', () => {
    expect(attemptWhy({ status: 'failed', error: 'timeout', responseCode: 410 })).toBe(
      'Your endpoint answered 410. Your endpoint did not answer in time.',
    );
  });
  it('promises a retry only while the delivery is waiting for one', () => {
    expect(attemptWhy({ status: 'interrupted', error: null, responseCode: null }, false)).toBe('The attempt was interrupted before it finished.');
    expect(attemptWhy({ status: 'interrupted', error: null, responseCode: null }, true)).toBe(
      'The attempt was interrupted before it finished; it is tried again.',
    );
  });
  it('tells a cursor review apart from a filter or scope hold', () => {
    const [cursor] = endpointStates({ cursorWarning: 'webhook_cursor_review_required' } as never);
    expect(cursor?.lost).toMatch(/queued, resends and test pings still go out/);
    expect(cursor?.lost).not.toMatch(/Nothing is sent/);
  });
});

describe('combined holds', () => {
  it('never tells the reader that test pings go out while a filter or scope hold stops them', () => {
    for (const extra of [{ filterWarning: 'webhook_filter_review_required' }, { scopeWarning: 'webhook_invalid_scope' }]) {
      const states = endpointStates({ cursorWarning: 'webhook_cursor_review_required', ...extra } as never);
      const cursor = states.find((s) => s.key === 'cursor');
      expect(cursor?.lost).toMatch(/Nothing is sent while the hold above lasts/);
      expect(cursor?.lost).not.toMatch(/still go out/);
    }
  });
});
