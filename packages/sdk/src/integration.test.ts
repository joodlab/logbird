import { afterEach, expect, it, vi } from 'vitest';
import { Trailmark } from './index';
import { createAudit, jobAudit, shutdown } from './integration';

afterEach(() => vi.useRealTimers());
function fixture() {
  const client = new Trailmark({ enabled: false });
  const track = vi.spyOn(client, 'track');
  return { client, track };
}
it('resolves per call, skips explicit overrides and stamps id/time before async work', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-05T10:00:00Z'));
  const { client, track } = fixture();
  const host: { user?: string } = {};
  const actor = vi.fn(async () => ({ id: host.user }));
  const audit = await createAudit({ client, actor }, host, new Request('http://host'));
  expect(actor).not.toHaveBeenCalled();
  host.user = 'late-user';
  const id = audit('updated');
  vi.setSystemTime(new Date('2026-11-05T11:00:00Z'));
  await audit.pending();
  expect(track.mock.calls[0]?.[0]).toMatchObject({ id, occurredAt: '2026-11-05T10:00:00.000Z', actor: { id: 'late-user' } });
  audit('override', { actor: undefined });
  await audit.pending();
  expect(actor).toHaveBeenCalledTimes(1);
  host.user = 'second-user';
  audit('again');
  await audit.pending();
  expect(track.mock.calls[2]?.[0].actor?.id).toBe('second-user');
});
it('isolates failed resolvers and skips every explicitly overridden field', async () => {
  const { client, track } = fixture();
  const fail = vi.fn(() => {
    throw new Error('resolver');
  });
  const onError = vi.fn();
  const audit = await createAudit(
    { client, actor: fail, tenant: () => ({ id: 'tenant' }), executor: fail, ip: fail, onError },
    {},
    new Request('http://host'),
  );
  audit('partial', { actor: undefined, executor: { id: 'override' }, context: { ip: undefined } });
  await audit.pending();
  expect(fail).not.toHaveBeenCalled();
  audit('failure');
  await audit.pending();
  expect(track.mock.calls[1]?.[0]).toMatchObject({ action: 'failure', tenant: { id: 'tenant' } });
  expect(track.mock.calls[1]?.[0].actor).toBeUndefined();
  expect(onError).toHaveBeenCalledTimes(3);
});
it('round trips JSON carriers through workers and nested jobs', async () => {
  const { client, track } = fixture();
  const audit = await createAudit(
    { client, actor: () => ({ id: 'user' }), requestId: () => 'host-id', operationId: () => 'host-operation' },
    {},
    new Request('http://host'),
  );
  const parentEventId = audit('api');
  const carrier = JSON.parse(JSON.stringify(await audit.carrier({ parentEventId })));
  const job = jobAudit({ client, job: { id: 42, name: 'send', queueName: 'mail', attemptsMade: 2 }, carrier });
  const id = job('job');
  await job.pending();
  expect(track.mock.calls[1]?.[0]).toMatchObject({
    id,
    actor: { id: 'user' },
    executor: { type: 'worker', id: 'mail', jobId: '42', attempt: 3 },
    context: { parentEventId, operationId: 'host-operation', requestId: 'host-id' },
  });
  expect(await job.carrier({ parentEventId: id })).toMatchObject({ parentEventId: id, operationId: 'host-operation', actor: { id: 'user' } });
});
it('omits jobId instead of sending "undefined" for jobs without an id', async () => {
  const { client, track } = fixture();
  const job = jobAudit({ client, job: { name: 'sweep', queueName: 'health' } });
  job('health.sweep.completed');
  await job.pending();
  expect(track.mock.calls[0]?.[0].executor).toEqual({ type: 'worker', id: 'health', name: 'sweep', jobId: undefined, attempt: 1 });
  expect(track.mock.calls[0]?.[0].actor).toEqual({ type: 'system', id: 'scheduler' });
});
it('shutdown waits for pending resolutions before closing the client', async () => {
  const { client, track } = fixture();
  let finish!: (actor: { id: string }) => void;
  const options = {
    client,
    actor: () =>
      new Promise<{ id: string }>((resolve) => {
        finish = resolve;
      }),
  };
  const close = vi.spyOn(client, 'shutdown');
  const audit = await createAudit(options, {}, new Request('http://host'));
  audit('pending');
  const closing = shutdown(options);
  await Promise.resolve();
  expect(close).not.toHaveBeenCalled();
  finish({ id: 'late' });
  await closing;
  expect(track).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});
