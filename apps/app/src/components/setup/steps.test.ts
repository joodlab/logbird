import { CONSOLE_TEST_EVENT_SOURCE, type ProjectSetup } from '@logbird/contracts';
import { describe, expect, it } from 'vitest';
import { onlyConsoleTest, stepCopy } from './steps';

const setup = (ingest: Partial<ProjectSetup['ingest']>) =>
  ({
    ingest: { activeIngestKeys: 1, firstEventAt: null, firstEvent: null, lastEventAt: null, eventsLast24h: 0, sampleEvents: 0, ...ingest },
  }) as unknown as ProjectSetup;
const minuteAgo = new Date(Date.now() - 60_000).toISOString();

describe('setup after the console test', () => {
  const consoleOnly = setup({ firstEventAt: minuteAgo, firstEvent: { source: CONSOLE_TEST_EVENT_SOURCE } as ProjectSetup['ingest']['firstEvent'] });
  it('says the console test proved the pipeline, and that it does not count for the backend', () => {
    expect(onlyConsoleTest(consoleOnly)).toBe(true);
    expect(stepCopy('first_event', consoleOnly, 'done').detail).toMatch(/^Console test received .*: the pipeline works\.$/);
    expect(stepCopy('recent_events', consoleOnly, 'todo').detail).toBe('From your backend: none yet (the console test doesn’t count).');
  });
  it('speaks of the backend once the backend has sent events', () => {
    const backend = setup({
      firstEventAt: minuteAgo,
      firstEvent: { source: 'api' } as ProjectSetup['ingest']['firstEvent'],
      lastEventAt: minuteAgo,
      eventsLast24h: 3,
    });
    expect(onlyConsoleTest(backend)).toBe(false);
    expect(stepCopy('first_event', backend, 'done').detail).toMatch(/^First event received /);
    expect(stepCopy('recent_events', backend, 'done').detail).toBe('3 events from your backend in the last 24 hours.');
    // A console test first, then the backend: no longer "only the console test".
    expect(onlyConsoleTest({ ...backend, ingest: { ...backend.ingest, firstEvent: consoleOnly.ingest.firstEvent } })).toBe(false);
  });
});
