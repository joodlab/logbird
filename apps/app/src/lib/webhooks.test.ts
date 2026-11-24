import { CONSOLE_ROUTES, type WebhookEndpoint } from '@logbird/contracts';
import { createRouter } from '@tanstack/react-router';
import { describe, expect, it } from 'vitest';
import { routeTree } from '@/routeTree.gen';
import { ApiRequestError } from './api/errors';
import {
  attemptErrorCopy,
  attemptWhy,
  deliveryWindowLine,
  disabledCopy,
  displayUrl,
  endpointPatch,
  endpointStates,
  type Form,
  fieldErrorsFromValidation,
  formFrom,
  isHoldRefusal,
  isWebhookBusy,
  LATE_EVENTS_APPROXIMATE,
  lateEventsCounted,
  lateEventsSentence,
  lenientDeliveriesSchema,
  scopeOf,
  scopeSummary,
  sendBlockedCopy,
  settledResends,
  storedScope,
  validateWebhookForm,
  webhookErrorCopy,
  webhookRetry,
  windowLabel,
  windowParts,
  windowSeconds,
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
    deliveryWindowSeconds: 604_800,
    lateEvents: { count: 0, since: '2026-10-24T10:00:00.000Z' },
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
  it('saving an endpoint whose filter cannot run always sends the filter, so the server can say why it still cannot', () => {
    const invalid = endpoint({ filterQuery: 'action:/(?=x)/', filterWarning: 'webhook_filter_invalid' });
    expect(endpointPatch(invalid, formFrom(invalid), scopeOf(formFrom(invalid)))).toEqual({ filterQuery: 'action:/(?=x)/' });
    // Nothing else held: an unchanged form sends nothing; the review hold is confirmed from its panel.
    const fine = endpoint({ filterQuery: 'action:x' });
    expect(endpointPatch(fine, formFrom(fine), scopeOf(formFrom(fine)))).toEqual({});
    const review = endpoint({ filterQuery: 'action:x', filterWarning: 'webhook_filter_review_required' });
    expect(endpointPatch(review, formFrom(review), scopeOf(formFrom(review)))).toEqual({});
  });
  it('explains a filter that cannot run as its own hold: what is wrong, that nothing is sent, and that editing clears it', () => {
    const held = endpoint({ filterWarning: 'webhook_filter_invalid' });
    const [state] = endpointStates(held);
    expect(state).toMatchObject({ key: 'filter', kind: 'hold', badge: 'Held: fix filter' });
    expect(state?.what).toMatch(/cannot be run/);
    expect(state?.what).toMatch(/RE2/);
    expect(state?.lost).toMatch(/Nothing is sent while it is held/);
    expect(state?.todo).toBe('Edit the filter so it can run. Saving a working filter clears this hold.');
    expect(state?.todo).not.toMatch(/confirm/i);
    expect(sendBlockedCopy({ enabled: true, filterWarning: 'webhook_filter_invalid', scopeWarning: undefined }, 'send a test ping')).toBe(
      'To send a test ping, fix its filter.',
    );
    // The API answers both filter holds with one code; the endpoint says which, and so does the copy.
    const refused = new ApiRequestError(409, 'webhook_filter_review_required', 'held');
    expect(webhookErrorCopy(refused, held)).toBe('This endpoint is held because its filter cannot run. Edit the filter first.');
    expect(webhookErrorCopy(refused, endpoint({ filterWarning: 'webhook_filter_review_required' }))).toMatch(/until its filter is confirmed/);
    // A hold newer than the page: the endpoint on screen shows none, so the copy does not guess which, and the caller
    // refreshes the endpoint.
    expect(webhookErrorCopy(refused, endpoint({}))).toBe('This endpoint was just paused because of its filter. Its card now says what to do.');
    expect(isHoldRefusal(refused)).toBe(true);
    expect(isHoldRefusal(new ApiRequestError(409, 'webhook_disabled', 'off'))).toBe(true);
    expect(isHoldRefusal(new ApiRequestError(409, 'webhook_delivery_pending', 'pending'))).toBe(false);
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

describe('cursor review on an endpoint that is off', () => {
  it('never says sends still go out while the endpoint is off', () => {
    const [cursor] = endpointStates({ enabled: false, cursorWarning: 'webhook_cursor_review_required' } as never);
    expect(cursor?.lost).toMatch(/Nothing is sent while the endpoint is off/);
    expect(cursor?.lost).not.toMatch(/still go out/);
    const both = endpointStates({
      enabled: false,
      cursorWarning: 'webhook_cursor_review_required',
      filterWarning: 'webhook_filter_review_required',
    } as never);
    expect(both.find((s) => s.key === 'cursor')?.lost).toMatch(/off and the hold above lasts/);
    // On, with only the cursor review: sends do go out.
    const [on] = endpointStates({ enabled: true, cursorWarning: 'webhook_cursor_review_required' } as never);
    expect(on?.lost).toMatch(/still go out/);
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

describe('settledResends', () => {
  it('settles a resend once a read started after it no longer lists it pending, and waits while that list has more pages', () => {
    const watching = new Map([
      ['d1', 100],
      ['d2', 100],
    ]);
    expect(settledResends(watching, { ids: ['d2'], complete: true, startedAt: 200 })).toEqual(['d1']);
    expect(settledResends(watching, { ids: [], complete: true, startedAt: 200 })).toEqual(['d1', 'd2']);
    expect(settledResends(watching, { ids: ['d9'], complete: false, startedAt: 200 })).toEqual([]);
  });

  it('never settles a resend from a read that was already in flight when it was queued', () => {
    // A queued at 100; the read started at 200; B queued at 300 while that read was in flight. The read lists neither.
    const watching = new Map([
      ['A', 100],
      ['B', 300],
    ]);
    expect(settledResends(watching, { ids: [], complete: true, startedAt: 200 })).toEqual(['A']);
    // The next read, started after B was queued, can settle it.
    expect(settledResends(new Map([['B', 300]]), { ids: [], complete: true, startedAt: 400 })).toEqual(['B']);
  });
});

describe('delivery window (#152)', () => {
  const ep = (deliveryWindowSeconds: number | null, count = 0) =>
    ({ deliveryWindowSeconds, lateEvents: { count, since: '2026-10-25T00:00:00.000Z' } }) as WebhookEndpoint;
  it('shows a new endpoint at the 7-day default, and an existing one at its own window or "No limit"', () => {
    expect(windowParts(604_800)).toEqual({ windowLimited: true, windowAmount: '7', windowUnit: 'days' });
    expect(windowParts(5400 * 2)).toEqual({ windowLimited: true, windowAmount: '3', windowUnit: 'hours' });
    expect(windowParts(null)).toMatchObject({ windowLimited: false });
    expect(formFrom(null)).toMatchObject({ windowLimited: true, windowAmount: '7', windowUnit: 'days' });
  });
  it('turns the form into seconds, null for no limit, and refuses what the contract refuses', () => {
    expect(windowSeconds({ windowLimited: true, windowAmount: '36', windowUnit: 'hours' })).toBe(129_600);
    expect(windowSeconds({ windowLimited: true, windowAmount: '2', windowUnit: 'days' })).toBe(172_800);
    expect(windowSeconds({ windowLimited: false, windowAmount: 'x', windowUnit: 'days' })).toBeNull();
    expect(windowSeconds({ windowLimited: true, windowAmount: '1.5', windowUnit: 'days' })).toBeUndefined();
    const base = { ...formFrom(null), url: 'https://hooks.example.com/x' };
    expect(validateWebhookForm({ ...base, windowAmount: '0' }).windowAmount).toBe('Choose from 1 to 3,650 days.');
    expect(validateWebhookForm({ ...base, windowAmount: '3651' }).windowAmount).toBe('Choose from 1 to 3,650 days.');
    expect(validateWebhookForm({ ...base, windowAmount: '3650' }).windowAmount).toBeUndefined();
    expect(validateWebhookForm({ ...base, windowUnit: 'hours', windowAmount: '87601' }).windowAmount).toMatch(/87,600 hours/);
    expect(validateWebhookForm({ ...base, windowAmount: 'soon' }).windowAmount).toBe('Enter a whole number of days.');
    expect(validateWebhookForm({ ...base, windowLimited: false, windowAmount: '' }).windowAmount).toBeUndefined();
  });
  it('sends the window only when it changed, and null to remove the limit', () => {
    const target = {
      ...ep(604_800),
      id: 'w',
      url: 'https://hooks.example.com/x',
      description: null,
      enabled: true,
      filterQuery: '',
      scope: null,
    } as WebhookEndpoint;
    const f = formFrom(target);
    expect(endpointPatch(target, f, scopeOf(f))).not.toHaveProperty('deliveryWindowSeconds');
    expect(endpointPatch(target, { ...f, windowAmount: '14' }, scopeOf(f))).toMatchObject({ deliveryWindowSeconds: 1_209_600 });
    expect(endpointPatch(target, { ...f, windowLimited: false }, scopeOf(f))).toMatchObject({ deliveryWindowSeconds: null });
  });
  it('says how many events came too late, with the approved meaning, and nothing when there is no window', () => {
    expect(lateEventsSentence(ep(604_800, 0), 'Oct 25, 2026')).toBe(
      'Since Oct 25, 2026, Logbird has recorded no event in this project arriving more than 7 days after it happened.',
    );
    expect(lateEventsSentence(ep(604_800, 1204), 'Oct 25, 2026')).toBe(
      'Since Oct 25, 2026, Logbird has recorded 1,204 events in this project arriving more than 7 days after they happened. The count covers the whole project, before this endpoint’s filter and scope.',
    );
    // Never claims a delivery outcome: the count is project-wide, before filter and scope.
    expect(lateEventsSentence(ep(604_800, 1204), 'Oct 25, 2026')).not.toMatch(/did not send/);
    expect(lateEventsSentence(ep(3600, 1), 'Oct 25, 2026')).toMatch(
      /^Since Oct 25, 2026, Logbird has recorded 1 event in this project arriving more than 1 hour after it happened/,
    );
    expect(lateEventsSentence(ep(null, 5), 'Oct 25, 2026')).toBeNull();
    // Right after a window change the count starts at the next whole hour: say so instead of a zero.
    const changed = { deliveryWindowSeconds: 604_800, lateEvents: { count: 0, since: '2026-11-24T03:00:00.000Z' } };
    expect(lateEventsSentence(changed, 'Nov 24, 2026, 04:00 Berlin', new Date('2026-11-24T02:10:00.000Z'))).toBe(
      'Logbird starts counting events that arrive more than 7 days late at Nov 24, 2026, 04:00 Berlin.',
    );
    expect(lateEventsSentence(changed, 'Nov 24, 2026, 04:00 Berlin', new Date('2026-11-24T03:00:00.000Z'))).toMatch(
      /^Since .+, Logbird has recorded no event/,
    );
    expect(windowLabel(null)).toBe('No limit');
    expect(deliveryWindowLine(null)).toBe('No limit on arrival time');
  });
});

describe('delivery window errors from the server (#152)', () => {
  it('puts a 422 on deliveryWindowSeconds beside the window field', () => {
    const error = new ApiRequestError(422, 'validation_error', 'Invalid', [{ path: ['deliveryWindowSeconds'], message: 'Too large' }]);
    expect(fieldErrorsFromValidation(error)).toEqual({ windowAmount: 'Too large' });
  });
});

describe('late-event count qualifier (#359: approximate by definition)', () => {
  const ep = (since: string, window: number | null = 604_800) => ({ deliveryWindowSeconds: window, lateEvents: { count: 3, since } });
  it('applies once counting has started, and never without a window', () => {
    const now = new Date('2026-11-24T03:00:00.000Z');
    expect(lateEventsCounted(ep('2026-11-24T03:00:00.000Z'), now)).toBe(true);
    expect(lateEventsCounted(ep('2026-11-24T04:00:00.000Z'), now)).toBe(false);
    expect(lateEventsCounted(ep('2026-11-24T02:00:00.000Z', null), now)).toBe(false);
    expect(LATE_EVENTS_APPROXIMATE).toBe('Approximate. It can be off after a storage failure or a restore.');
  });
});
