import { createHash } from 'node:crypto';
import type { EventInput } from '@logbird/sdk';
import { describe, expect, it } from 'vitest';
import { generateEvents, type SeedOptions } from './index';

const options = { events: 300_000, days: 60, project: 'StayDesk', now: new Date('2026-11-04T12:00:00Z'), seed: 42 };
const DAY = 86_400_000;
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

it('gives business-scoped scheduler and partner identities distinct names', () => {
  const names = new Map<string, string>();
  for (const e of generateEvents(options)) {
    if (e.actor?.type === 'system' || e.actor?.type === 'api_key') {
      const previous = names.get(e.actor.name ?? '');
      if (previous) expect(previous).toBe(e.actor.id);
      names.set(e.actor.name ?? '', e.actor.id ?? '');
    }
  }
  expect(names.size).toBeGreaterThan(24);
});

describe('profiles', () => {
  const fingerprint = (input: SeedOptions) => {
    const hash = createHash('sha256');
    for (const event of generateEvents(input)) hash.update(`${JSON.stringify(event)}\n`);
    return hash.digest('hex');
  };
  it('keeps deterministic demo fixtures with illustrative queue and job labels', () => {
    // Fixture digests with the demo's windows: min(60, retention - 1)
    // days, so 59 for StayDesk (90-day retention) and 29 for Ledger demo (30-day retention).
    const demo = { seed: 42, now: options.now, profile: 'staydesk' } as const;
    expect(fingerprint({ ...demo, days: 59, events: 300_000, project: 'StayDesk' })).toBe(
      'a61b8706a175485667aa5e7666046afe7a2ba3e32d6c079df2d59d2d21ef67da',
    );
    expect(fingerprint({ ...demo, days: 29, events: 5000, project: 'Ledger demo' })).toBe(
      '410e1f93728ab9eb7b0e23c9f19b6a08589ff48ab12723a41aefc954dc94b6dd',
    );
  }, 60_000);
  it('uses neutral, fictional source and integration names by default', () => {
    const sources = new Set<string>();
    const integrations = new Set<string>();
    for (const event of generateEvents({ ...options, events: 20_000, project: 'Hotel demo', spread: true })) {
      expect(JSON.stringify(event)).not.toMatch(/acme/i);
      sources.add(event.source as string);
      if (event.actor?.type === 'integration') integrations.add(event.actor.id as string);
    }
    expect([...sources].sort()).toEqual(['booking-engine', 'channel-manager', 'meta-whatsapp', 'payment-provider']);
    expect([...integrations].sort()).toEqual(['channel-manager', 'meta-whatsapp', 'payment-provider']);
    const legacy = [...generateEvents({ ...options, events: 20_000, profile: 'staydesk', spread: true })];
    expect(new Set(legacy.map((event) => event.source))).toEqual(new Set(['staydesk', 'staybook', 'meta-whatsapp', 'payment-provider']));
  });
  it('rejects an unknown profile', () => {
    expect(() => [...generateEvents({ ...options, events: 1, profile: 'other' as never })]).toThrow('Invalid seed options');
  });
});

describe('spread over a recent window', () => {
  type Mix = { scheduled: number; impersonated: number; retried: number; multiTarget: number; interactive: number };
  const mix = (events: EventInput[]): Mix => ({
    scheduled: events.filter((e) => e.metadata?.schedulerId).length / events.length,
    impersonated: events.filter((e) => e.impersonator).length / events.length,
    retried: events.filter((e) => (e.executor?.attempt ?? 0) > 1).length / events.length,
    multiTarget: events.filter((e) => (e.targets?.length ?? 0) > 1).length / events.length,
    interactive: events.filter((e) => e.context?.requestId).length / events.length,
  });
  // The full fixture's mix (the default 300k, 60-day prefix stream) is the reference.
  const reference = mix([...generateEvents(options)]);

  it('spreads a small count over the most recent day, ending now, with the full fixture mix', () => {
    const end = options.now.getTime();
    const events = [...generateEvents({ ...options, events: 400, days: 1, spread: true })];
    expect(events).toHaveLength(400);
    const times = events.map((e) => Date.parse(e.occurredAt as string)).sort((a, b) => a - b);
    // Every event is inside the last day, and they cover it: no gap longer than a fifth of the window at either end.
    expect(times[0]).toBeGreaterThanOrEqual(end - DAY);
    expect(times.at(-1)).toBeLessThan(end);
    expect(times[0]).toBeLessThan(end - 0.8 * DAY);
    expect(times.at(-1)).toBeGreaterThan(end - 0.2 * DAY);
    // The console's default "Last 24 hours" has recent traffic: something in the last hour.
    expect(times.filter((time) => time > end - 3_600_000).length).toBeGreaterThan(0);
    const small = mix(events);
    expect(small.impersonated).toBeGreaterThan(0);
    expect(small.retried).toBeGreaterThan(0);
    expect(small.multiTarget).toBeGreaterThan(0);
    expect(small.interactive).toBeGreaterThan(0);
    // Proportional to the full fixture, within sampling noise for 400 events.
    expect(Math.abs(small.scheduled - reference.scheduled)).toBeLessThan(0.05);
    expect(Math.abs(small.multiTarget - reference.multiTarget)).toBeLessThan(0.12);
    expect(small.impersonated / reference.impersonated).toBeGreaterThan(0.3);
    expect(small.impersonated / reference.impersonated).toBeLessThan(3);
    expect(small.retried / reference.retried).toBeGreaterThan(0.3);
    expect(small.retried / reference.retried).toBeLessThan(3);
  });

  it('keeps trees, actors and attempts valid, and is reproducible', () => {
    const input = { ...options, events: 2000, days: 7, spread: true };
    const events = [...generateEvents(input)];
    expect(JSON.stringify(events)).toBe(JSON.stringify([...generateEvents(input)]));
    const seen = new Map(events.map((event) => [event.id, event]));
    for (const event of events) {
      const parent = event.context?.parentEventId;
      if (!parent) continue;
      const ancestor = seen.get(parent);
      expect(ancestor?.context?.operationId).toBe(event.context?.operationId);
      expect(Date.parse(ancestor?.occurredAt as string)).toBeLessThanOrEqual(Date.parse(event.occurredAt as string));
      if (event.actor && ancestor?.actor) expect(event.actor.id).toBe(ancestor.actor.id);
    }
    for (const event of events.filter((e) => e.metadata?.schedulerId)) expect(event.occurredAt).toMatch(/T\d\d:(0[5-9]|3[5-9]):/);
    expect(mix(events).scheduled).toBeGreaterThan(0.4);
  });

  it('needs a window with at least one scheduler slot', () => {
    expect(() => [...generateEvents({ ...options, events: 10, days: 1 / 48, spread: true })]).toThrow('Invalid seed options');
  });
});
