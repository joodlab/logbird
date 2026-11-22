import { createRouter } from '@tanstack/react-router';
import { describe, expect, it } from 'vitest';
import { routeTree } from '@/routeTree.gen';
import { ApiRequestError } from './api/errors';
import { disabledCopy, displayUrl, isWebhookBusy, scopeSummary, webhookErrorCopy, webhookRetry } from './webhooks';

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
