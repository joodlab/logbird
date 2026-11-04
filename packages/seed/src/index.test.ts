import { expect, it } from 'vitest';
import { generateEvents } from './index';

it('is deterministic, bounded and has valid causal parents', () => {
  const options = { events: 1000, days: 60, project: 'JoodCMS', now: new Date('2026-11-04T00:00:00Z') };
  const events = [...generateEvents(options)];
  expect(events).toEqual([...generateEvents(options)]);
  expect(events).toHaveLength(1000);
  const seen = new Set();
  for (const e of events) {
    if (e.context?.parentEventId) expect(seen.has(e.context.parentEventId)).toBe(true);
    seen.add(e.id);
  }
  expect(events.some((e) => e.executor?.type === 'worker')).toBe(true);
  expect(events.some((e) => e.actor?.type === 'system')).toBe(true);
});
