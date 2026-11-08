import { expect, it, vi } from 'vitest';
import { exportFailureDescription } from './export-error';

const id = 'f1ca922f-e899-468f-a065-dc23cc43265e';
it('uses the durable reason and id instead of a browser network error', async () => {
  const description = 'Export f1ca922f: stored events changed; retry the export';
  const lookup = vi.fn().mockResolvedValue({ exportId: id, state: 'failed', reason: 'membership_changed', description });
  expect(await exportFailureDescription(id, lookup)).toBe(description);
  expect(lookup.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
});
it('preserves the id and activity destination if outcome storage is unavailable', async () => {
  const text = await exportFailureDescription(id, vi.fn().mockRejectedValue(new Error('private backend error')));
  expect(text).toContain('f1ca922f');
  expect(text).toContain('Workspace activity');
  expect(text).not.toContain('private');
});
it('distinguishes a lost download from producer completion', async () => {
  expect(await exportFailureDescription(id, vi.fn().mockResolvedValue({ state: 'completed' }))).toContain(
    'completed on the server, but the download was interrupted',
  );
});
