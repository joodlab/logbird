import { describe, expect, it } from 'vitest';
import { generateEvents } from './index';

const options = { events: 300_000, days: 60, project: 'JoodCMS', now: new Date('2026-11-04T12:00:00Z'), seed: 42 };
describe('fictional hospitality fixtures', () => {
  it('is reproducible and changes with the seed', () => {
    const small = { ...options, events: 80 };
    expect([...generateEvents(small)]).toEqual([...generateEvents(small)]);
    expect([...generateEvents(small)]).not.toEqual([...generateEvents({ ...small, seed: 43 })]);
  });
  it('streams 300k events with valid trees, distinct vocabulary and safe identities', () => {
    const ids = new Map<string, { operation?: string; actor?: string; time: number }>();
    const actions = new Set<string>();
    const tenants = new Set<string>();
    const actors = new Set<string>();
    const outcomes = new Set<string>();
    const hours = new Set<string>();
    let legacy = 0;
    let workers = 0;
    let retries = 0;
    let count = 0;
    const started = performance.now();
    for (const event of generateEvents(options)) {
      count++;
      actions.add(event.action);
      outcomes.add(event.outcome as string);
      tenants.add(event.tenant?.id as string);
      if (event.actor?.type === 'user') actors.add(event.actor.id as string);
      const parent = event.context?.parentEventId;
      const time = Date.parse(event.occurredAt as string);
      expect(time).toBeLessThan(options.now.getTime());
      expect(time).toBeGreaterThanOrEqual(options.now.getTime() - 60 * 86_400_000);
      if (parent) {
        const ancestor = ids.get(parent);
        expect(ancestor).toBeDefined();
        expect(ancestor?.operation).toBe(event.context?.operationId);
        expect(ancestor?.time).toBeLessThanOrEqual(time);
        if (event.actor && ancestor?.actor) expect(event.actor.id).toBe(ancestor.actor);
      }
      if (event.executor?.type === 'worker') {
        workers++;
        expect(event.executor.jobId).toBeTruthy();
        expect(event.executor.attempt).toBeGreaterThanOrEqual(1);
        expect(parent).toBeTruthy();
        if ((event.executor.attempt ?? 0) > 1) retries++;
      }
      if (event.executor?.type === 'scheduler') {
        if (event.actor) expect(event.actor.type).toBe('system');
        expect(event.metadata?.schedulerId).toBe(event.actor?.id ?? event.performed_by);
        hours.add(`${event.actor?.id}:${(event.occurredAt as string).slice(0, 13)}`);
      }
      if (event.context?.requestId) {
        expect(event.context.traceId).toMatch(/^[a-f0-9]{32}$/);
        expect(event.context.ip).toMatch(/^(203\.0\.113|198\.51\.100)\.\d+$/);
      }
      if (event.actor?.email) expect(event.actor.email).toMatch(/@example\.com$/);
      const json = JSON.stringify(event);
      expect(json).not.toMatch(/(?:\+966|\+971|\+974)\d{7,}/);
      for (const email of json.matchAll(/[\w.+-]+@([\w.-]+)/g)) expect(email[1]).toMatch(/(?:^|\.)example\.com$|\.test$/);
      if (event.performed_by || event.legacy || event.provider_extension) legacy++;
      ids.set(event.id as string, { operation: event.context?.operationId, actor: event.actor?.id, time });
    }
    expect(count).toBe(300_000);
    expect(actions.size).toBeGreaterThanOrEqual(80);
    expect(actions.size).toBeLessThanOrEqual(120);
    expect(tenants.size).toBe(30);
    expect(actors.size).toBe(150);
    expect([...outcomes].sort()).toEqual(['denied', 'failure', 'partial', 'success', 'unknown']);
    expect(legacy / count).toBe(0.025);
    expect(workers).toBeGreaterThan(100_000);
    expect(retries).toBeGreaterThan(0);
    expect(hours.size).toBeGreaterThan(30_000);
    expect(performance.now() - started).toBeLessThan(60_000);
  }, 60_000);
  it('uses independent accounting vocabulary and legacy fields', () => {
    const events = [...generateEvents({ ...options, events: 5000, project: 'Ledger demo' })];
    const actions = new Set(events.map((e) => e.action));
    expect(actions.has('invoice.approved')).toBe(true);
    expect(actions.has('vendor.bank_details.changed')).toBe(true);
    expect(actions.has('journal.posted')).toBe(true);
    expect(events.some((e) => e.legacy)).toBe(true);
    expect(events.every((e) => !e.action.startsWith('hotel.'))).toBe(true);
    const seen = new Map(events.map((event) => [event.id, event]));
    for (const event of events) {
      if (!event.context?.parentEventId) continue;
      const parent = seen.get(event.context.parentEventId);
      expect(parent).toBeDefined();
      expect(parent?.context?.operationId).toBe(event.context.operationId);
      if (parent?.actor && event.actor) expect(parent.actor.id).toBe(event.actor.id);
    }
    expect(events.some((e) => e.executor?.type === 'worker')).toBe(true);
    expect(events.some((e) => e.executor?.type === 'scheduler')).toBe(false);
  });
});
