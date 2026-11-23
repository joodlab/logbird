// @vitest-environment happy-dom
import type { ProjectSetup } from '@logbird/contracts';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { toast } from 'sonner';
import { afterEach, expect, it, vi } from 'vitest';
import { useFirstArrival } from './use-first-arrival';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;

/** Setup as the panel polls it: only the ingest facts the arrival reads. */
const setup = (ingest: { firstEventAt: string | null; source?: string; lastEventAt: string | null }) =>
  ({
    ingest: {
      firstEventAt: ingest.firstEventAt,
      firstEvent: ingest.source ? { source: ingest.source } : null,
      lastEventAt: ingest.lastEventAt,
    },
  }) as unknown as ProjectSetup;

function Harness({ data, onArrive }: { data: ProjectSetup | undefined; onArrive: () => void }) {
  const celebrate = useFirstArrival(data, onArrive);
  return <span data-celebrate={celebrate} />;
}

function watch(onArrive = vi.fn()) {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const show = (data: ProjectSetup | undefined) => act(() => root?.render(<Harness data={data} onArrive={onArrive} />));
  return { show, onArrive, celebrating: () => host.querySelector('span')?.getAttribute('data-celebrate') === 'true' };
}

afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

it('a console test and a backend event landing before the next poll: the toast says the backend has sent events (#238)', () => {
  const success = vi.spyOn(toast, 'success').mockImplementation(() => 'toast');
  const panel = watch();
  panel.show(setup({ firstEventAt: null, lastEventAt: null }));
  panel.show(setup({ firstEventAt: '2026-11-23T10:00:00.000Z', source: 'logbird-test', lastEventAt: '2026-11-23T10:00:01.000Z' }));
  expect(success).toHaveBeenCalledExactlyOnceWith('Console test received', {
    description: 'Your backend has sent events since: your integration works.',
  });
  expect(panel.onArrive).toHaveBeenCalledOnce();
  expect(panel.celebrating()).toBe(true);
});

it('a console test alone still asks for a backend event', () => {
  const success = vi.spyOn(toast, 'success').mockImplementation(() => 'toast');
  const panel = watch();
  panel.show(setup({ firstEventAt: null, lastEventAt: null }));
  panel.show(setup({ firstEventAt: '2026-11-23T10:00:00.000Z', source: 'logbird-test', lastEventAt: null }));
  expect(success).toHaveBeenCalledExactlyOnceWith('Console test received', {
    description: 'Logbird is receiving events. Send one from your backend to check your integration.',
  });
});

it('says nothing when the project already had an event when the panel first looked', () => {
  const success = vi.spyOn(toast, 'success').mockImplementation(() => 'toast');
  const panel = watch();
  panel.show(setup({ firstEventAt: '2026-11-23T10:00:00.000Z', source: 'booking-service', lastEventAt: '2026-11-23T10:00:00.000Z' }));
  panel.show(setup({ firstEventAt: '2026-11-23T10:00:00.000Z', source: 'booking-service', lastEventAt: '2026-11-23T10:05:00.000Z' }));
  expect(success).not.toHaveBeenCalled();
  expect(panel.onArrive).not.toHaveBeenCalled();
  expect(panel.celebrating()).toBe(false);
});
