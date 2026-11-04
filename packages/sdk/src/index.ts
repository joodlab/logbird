/** Copied structural envelope: no runtime or workspace dependency in the published SDK. */
export interface EventInput {
  action: string;
  id?: string;
  occurredAt?: string | number;
  environment?: string;
  outcome?: string;
  severity?: string;
  description?: string;
  actor?: { type?: string; id?: string; name?: string; email?: string; [key: string]: unknown };
  impersonator?: { id?: string; name?: string; [key: string]: unknown };
  executor?: { type?: string; id?: string; name?: string; jobId?: string; attempt?: number; [key: string]: unknown };
  tenant?: { id: string; name?: string; [key: string]: unknown };
  source?: string;
  targets?: { type: string; id: string; name?: string; [key: string]: unknown }[];
  changes?: { field: string; before?: unknown; after?: unknown }[];
  context?: {
    operationId?: string;
    parentEventId?: string;
    requestId?: string;
    traceId?: string;
    ip?: string;
    userAgent?: string;
    [key: string]: unknown;
  };
  metadata?: Record<string, unknown>;
  schemaVersion?: string;
  [key: string]: unknown;
}
export function uuidv7(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let time = Date.now();
  for (let i = 5; i >= 0; i--) {
    bytes[i] = time % 256;
    time = Math.floor(time / 256);
  }
  bytes[6] = ((bytes[6] ?? 0) & 15) | 112;
  bytes[8] = ((bytes[8] ?? 0) & 63) | 128;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export interface TrailmarkOptions {
  apiKey: string;
  endpoint: string;
  batchSize?: number;
  flushIntervalMs?: number;
  maxRetries?: number;
  onError?: (error: Error) => void;
}
export class Trailmark {
  private readonly queue: EventInput[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: Promise<void> | undefined;
  private closed = false;
  private readonly batchSize: number;
  private readonly interval: number;
  private readonly retries: number;
  constructor(private readonly options: TrailmarkOptions) {
    this.batchSize = options.batchSize ?? 100;
    this.interval = options.flushIntervalMs ?? 1000;
    this.retries = options.maxRetries ?? 5;
    if (
      !Number.isInteger(this.batchSize) ||
      this.batchSize < 1 ||
      this.batchSize > 1000 ||
      !Number.isFinite(this.interval) ||
      this.interval < 1 ||
      !Number.isInteger(this.retries) ||
      this.retries < 0
    )
      throw new Error('Invalid batching options');
  }
  private report(error: unknown) {
    try {
      this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
    } catch {
      /* A diagnostic hook must never break capture. */
    }
  }
  track(event: EventInput): void {
    try {
      if (this.closed) throw new Error('Trailmark is shut down');
      const serialized = JSON.stringify({ ...event, id: event.id ?? uuidv7(), occurredAt: event.occurredAt ?? new Date().toISOString() });
      if (new TextEncoder().encode(serialized).length > 256 * 1024) throw new Error('Event exceeds 256 KB');
      const copy = JSON.parse(serialized) as EventInput;
      this.queue.push(copy);
      if (this.queue.length >= this.batchSize) void this.flush().catch((e) => this.report(e));
      else this.schedule();
    } catch (e) {
      this.report(e);
    }
  }
  private schedule() {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush().catch((e) => this.report(e));
    }, this.interval);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }
  private async send(batch: EventInput[]) {
    const body = JSON.stringify({ events: batch });
    for (let attempt = 0; ; attempt++) {
      let response: Response | undefined, error: unknown;
      try {
        response = await fetch(`${this.options.endpoint.replace(/\/$/, '')}/v1/events`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.options.apiKey}`, 'Content-Type': 'application/json', 'X-Trailmark-SDK': 'typescript/0.0.0' },
          body,
          signal: AbortSignal.timeout(30_000),
        });
      } catch (e) {
        error = e;
      }
      if (response?.ok) {
        const result = (await response.json()) as { rejected?: unknown[] };
        if (result.rejected?.length) this.report(new Error(`${result.rejected.length} events rejected by Trailmark`));
        return;
      }
      const retry = !response || response.status === 429 || response.status >= 500;
      if (!retry || attempt >= this.retries) throw error ?? new Error(`Trailmark HTTP ${response?.status}`);
      const retryAfter = response?.headers.get('Retry-After');
      const seconds = retryAfter ? Number(retryAfter) : Number.NaN;
      const delay = Number.isFinite(seconds) ? seconds * 1000 : Math.min(30_000, 250 * 2 ** attempt) * (0.5 + Math.random());
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(60_000, delay))));
    }
  }
  flush(): Promise<void> {
    if (this.pending) return this.pending;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = (async () => {
      while (this.queue.length) {
        const batch: EventInput[] = [];
        let bytes = 32;
        while (this.queue.length && batch.length < this.batchSize) {
          const next = this.queue[0];
          if (!next) break;
          const size = new TextEncoder().encode(JSON.stringify(next)).length + 1;
          if (batch.length && bytes + size > 5 * 1024 * 1024) break;
          this.queue.shift();
          batch.push(next);
          bytes += size;
        }
        try {
          await this.send(batch);
        } catch (e) {
          this.queue.unshift(...batch);
          throw e;
        }
      }
    })().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  async shutdown(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.flush();
  }
}
