import { CONSOLE_ROUTES, type WebhookEndpoint } from '@logbird/contracts';
import { createRouter } from '@tanstack/react-router';
import { describe, expect, it } from 'vitest';
import { routeTree } from '@/routeTree.gen';
import { ApiRequestError } from './api/errors';
import {
  attemptErrorCopy,
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
