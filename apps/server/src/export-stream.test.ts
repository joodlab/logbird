import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { auditedExport, drainExportAudits } from './export-stream';

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
    ['export.completed', { rows: 1, bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') }],
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

it('fails closed for requested storage and preserves completed bytes through terminal storage failure', async () => {
  const next = vi.fn();
  async function* chunks() {
    next();
    yield '{}\n';
  }
  const receipt = vi.fn().mockRejectedValue(new Error('audit unavailable'));
  await expect(auditedExport(chunks(), false, receipt, new AbortController().signal)).rejects.toThrow('audit unavailable');
  expect(next).not.toHaveBeenCalled();
  expect(receipt.mock.calls.map(([action]) => action)).toEqual(['export.requested', 'export.failed']);
  expect(receipt.mock.calls.at(-1)?.[1]).toEqual({ rows: 0, bytes: 0, reason: 'audit_unavailable' });
  receipt.mockResolvedValueOnce(undefined);
  const reader = (await auditedExport(chunks(), false, receipt, new AbortController().signal)).getReader();
  await reader.read();
  expect(await reader.read()).toMatchObject({ done: true });
});

it('correlates a terminal audit outage without breaking bytes or logging private errors', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  async function* chunks() {
    yield '{}\n';
  }
  try {
    const receipt = vi.fn(async (action: string) => {
      if (action === 'export.completed') throw new Error('private storage credentials');
    });
    const body = await auditedExport(chunks(), false, receipt, new AbortController().signal, 'qa-export-diagnostics');
    expect(await new Response(body).text()).toBe('{}\n');
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({
        event: 'export.audit_storage_unavailable',
        exportId: 'qa-export-diagnostics',
        action: 'export.completed',
      }),
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain('private storage credentials');
  } finally {
    log.mockRestore();
  }
});

it('records cancellation after a completion receipt that is still in flight', async () => {
  let started!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const receipt = vi.fn(async (action: string) => {
    if (action === 'export.completed') {
      started();
      await blocked;
    }
  });
  async function* chunks() {
    yield '{}\n';
  }
  const abort = new AbortController();
  const reader = (await auditedExport(chunks(), false, receipt, abort.signal)).getReader();
  await reader.read();
  const end = reader.read();
  await entered;
  abort.abort();
  await expect(end).rejects.toThrow('Export aborted');
  release();
  await vi.waitFor(() => expect(receipt.mock.calls.map(([action]) => action)).toEqual(['export.requested', 'export.completed', 'export.failed']));
});
it('audits invalid range and unavailable-client preparation inside the lifecycle', async () => {
  const receipt = vi.fn().mockResolvedValue(undefined);
  await expect(
    auditedExport(
      async () => {
        throw new Error('Invalid time range');
      },
      false,
      receipt,
      new AbortController().signal,
    ),
  ).rejects.toThrow('Invalid time range');
  expect(receipt.mock.calls.at(-1)).toEqual(['export.failed', { rows: 0, bytes: 0, reason: 'invalid_query' }]);
  receipt.mockClear();
  await expect(
    auditedExport(
      async () => {
        throw Object.assign(new Error('safe'), { code: 'sql_mode_unavailable' });
      },
      false,
      receipt,
      new AbortController().signal,
    ),
  ).rejects.toThrow('safe');
  expect(receipt.mock.calls.at(-1)).toEqual(['export.failed', { rows: 0, bytes: 0, reason: 'sql_unavailable' }]);
});

it('releases admission and records a safe reason when a consumer stalls', async () => {
  async function* chunks() {
    while (true) yield '{}\n';
  }
  const receipt = vi.fn().mockResolvedValue(undefined);
  const release = vi.fn().mockResolvedValue(undefined);
  const reader = (
    await auditedExport(chunks(), false, receipt, new AbortController().signal, 'qa-idle', { idleMs: 20, onSettled: release })
  ).getReader();
  await reader.read();
  await new Promise((resolve) => setTimeout(resolve, 60));
  await expect(reader.read()).rejects.toThrow('idle timeout');
  expect(receipt.mock.calls.at(-1)?.[1].reason).toBe('idle_timeout');
  expect(release).toHaveBeenCalledExactlyOnceWith('export.failed');
});

it('freezes cancellation promptly but keeps SQL admission charged through a deferred page and iterator cleanup', async () => {
  let finishPage!: () => void, entered!: () => void;
  const page = new Promise<void>((resolve) => {
    finishPage = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let capacity = 2;
  const receipt = vi.fn().mockResolvedValue(undefined),
    terminal = vi.fn().mockResolvedValue(undefined);
  const release = vi.fn(async () => {
    capacity = 0;
  });
  const closed = vi.fn();
  async function* source() {
    try {
      yield '{}\n';
      entered();
      await page;
      yield '{}\n';
    } finally {
      closed();
    }
  }
  const abort = new AbortController();
  const reader = (
    await auditedExport(source(), false, receipt, abort.signal, 'deferred-sql', { onTerminal: terminal, onSettled: release })
  ).getReader();
  await reader.read();
  const pending = reader.read();
  await started;
  abort.abort();
  await expect(pending).rejects.toThrow('Export aborted');
  await vi.waitFor(() => expect(terminal).toHaveBeenCalledWith('export.failed'));
  const admitSql = () => {
    if (capacity + 2 > 2) throw new Error('export_busy');
  };
  expect(admitSql).toThrow('export_busy');
  expect(release).not.toHaveBeenCalled();
  finishPage();
  await drainExportAudits();
  expect(closed).toHaveBeenCalledOnce();
  expect(release).toHaveBeenCalledOnce();
  expect(admitSql).not.toThrow();
  expect(receipt.mock.calls.map(([action]) => action)).toEqual(['export.requested', 'export.failed']);
});

it('shutdown drains a terminal confirmation still pending after the response closes', async () => {
  let confirm!: () => void;
  const confirmation = new Promise<void>((resolve) => {
    confirm = resolve;
  });
  const release = vi.fn().mockResolvedValue(undefined);
  async function* source() {
    yield '{}\n';
  }
  const body = await auditedExport(source(), false, vi.fn().mockResolvedValue(undefined), new AbortController().signal, 'confirmation-drain', {
    onTerminal: () => confirmation,
    onSettled: release,
  });
  expect(await new Response(body).text()).toBe('{}\n');
  let drained = false;
  const pending = drainExportAudits().then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  expect(release).not.toHaveBeenCalled();
  confirm();
  await pending;
  expect(release).toHaveBeenCalledOnce();
});

it('does not count final-boundary waiting as a consumer idle timeout', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const receipt = vi.fn().mockResolvedValue(undefined);
  async function* chunks() {
    yield '{}\n';
  }
  let text: Promise<string> | undefined;
  try {
    const stream = await auditedExport(chunks(), false, receipt, new AbortController().signal, undefined, {
      idleMs: 20,
      maxDurationMs: 200,
      beforeComplete: async () => {
        entered();
        await gate;
      },
    });
    text = new Response(stream).text();
    const settled = text.then(
      () => true,
      () => false,
    );
    await waiting;
    await vi.advanceTimersByTimeAsync(80);
    expect(receipt.mock.calls.some(([action]) => action === 'export.failed')).toBe(false);
    release();
    expect(await settled).toBe(true);
    expect(await text).toBe('{}\n');
    await drainExportAudits();
    expect(receipt.mock.calls.at(-1)?.[0]).toBe('export.completed');
  } finally {
    release();
    await text?.catch(() => undefined);
    vi.useRealTimers();
  }
});
it('still cancels while final-boundary waiting has its idle timer cleared', async () => {
  const receipt = vi.fn().mockResolvedValue(undefined),
    abort = new AbortController();
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  async function* chunks() {
    yield '{}\n';
  }
  const stream = await auditedExport(chunks(), false, receipt, abort.signal, undefined, {
    beforeComplete: async (signal) => {
      entered();
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Boundary canceled')), { once: true }));
    },
  });
  const text = new Response(stream).text();
  const settled = text.then(
    () => false,
    () => true,
  );
  await waiting;
  abort.abort();
  expect(await settled).toBe(true);
  await drainExportAudits();
  expect(receipt.mock.calls.at(-1)?.[1].reason).toBe('client_aborted');
});
