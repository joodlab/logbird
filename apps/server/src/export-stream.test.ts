import { expect, it, vi } from 'vitest';
import { auditedExport } from './export-stream';

it('counts UTF-8 bytes and rows separately from the CSV header', async () => {
  const receipt = vi.fn().mockResolvedValue(undefined);
  async function* chunks() {
    yield 'id,description\n';
    yield '1,"é\ntext"\n';
  }
  const stream = await auditedExport(chunks(), true, receipt, new AbortController().signal);
  const text = await new Response(stream).text();
  expect(receipt.mock.calls).toEqual([
    ['export.requested', { rows: 0, bytes: 0 }],
    ['export.completed', { rows: 1, bytes: Buffer.byteLength(text) }],
  ]);
});

it('records partial export failure and closes its iterator', async () => {
  const receipt = vi.fn().mockResolvedValue(undefined);
  const closed = vi.fn();
  async function* chunks() {
    try {
      yield '{}\n';
      throw new Error('private storage details');
    } finally {
      closed();
    }
  }
  const reader = (await auditedExport(chunks(), false, receipt, new AbortController().signal)).getReader();
  await reader.read();
  await expect(reader.read()).rejects.toThrow();
  expect(receipt.mock.calls.at(-1)).toEqual(['export.failed', { rows: 1, bytes: 3, reason: 'export_error' }]);
  expect(JSON.stringify(receipt.mock.calls)).not.toContain('private storage details');
  expect(closed).toHaveBeenCalledOnce();
});

it('records a client cancellation once and never records completion', async () => {
  const receipt = vi.fn().mockResolvedValue(undefined);
  const closed = vi.fn();
  async function* chunks() {
    try {
      while (true) yield '{}\n';
    } finally {
      closed();
    }
  }
  const controller = new AbortController();
  const reader = (await auditedExport(chunks(), false, receipt, controller.signal)).getReader();
  await reader.read();
  await reader.cancel();
  controller.abort();
  expect(receipt.mock.calls.map(([action]) => action)).toEqual(['export.requested', 'export.failed']);
  expect(receipt.mock.calls.at(-1)?.[1].reason).toBe('client_aborted');
  expect(closed).toHaveBeenCalledOnce();
});

it('records request-signal aborts and pre-stream query failures', async () => {
  const receipt = vi.fn().mockResolvedValue(undefined);
  async function* chunks() {
    while (true) yield '{}\n';
  }
  const controller = new AbortController();
  const reader = (await auditedExport(chunks(), false, receipt, controller.signal)).getReader();
  await reader.read();
  controller.abort();
  await expect(reader.read()).rejects.toThrow('Export aborted');
  expect(receipt.mock.calls.map(([action]) => action)).toEqual(['export.requested', 'export.failed']);
  receipt.mockClear();
  // biome-ignore lint/correctness/useYield: a query can reject before the generator yields its first chunk.
  async function* broken(): AsyncGenerator<string, void> {
    throw new Error('unavailable');
  }
  await expect(auditedExport(broken(), false, receipt, new AbortController().signal)).rejects.toThrow('unavailable');
  expect(receipt.mock.calls).toEqual([
    ['export.requested', { rows: 0, bytes: 0 }],
    ['export.failed', { rows: 0, bytes: 0, reason: 'export_error' }],
  ]);
});

it('fails closed when the requested or terminal audit cannot be stored', async () => {
  const next = vi.fn();
  async function* chunks() {
    next();
    yield '{}\n';
  }
  const receipt = vi.fn().mockRejectedValue(new Error('audit unavailable'));
  await expect(auditedExport(chunks(), false, receipt, new AbortController().signal)).rejects.toThrow('audit unavailable');
  expect(next).not.toHaveBeenCalled();
  receipt.mockResolvedValueOnce(undefined);
  const reader = (await auditedExport(chunks(), false, receipt, new AbortController().signal)).getReader();
  await reader.read();
  await expect(reader.read()).rejects.toThrow('audit unavailable');
});
