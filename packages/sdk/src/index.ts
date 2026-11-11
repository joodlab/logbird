export {
  generateWebhookSecret,
  type SignWebhookOptions,
  signWebhook,
  type VerifyWebhookOptions,
  verifyWebhook,
  type WebhookHeaders,
  WebhookVerificationError,
  type WebhookVerificationReason,
} from './webhooks';

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
export interface LogbirdOptions {
  apiKey?: string;
  endpoint?: string;
  enabled?: boolean;
  defaults?: Partial<EventInput>;
  beforeSend?: (event: EventInput) => EventInput | null | undefined;
  batchSize?: number;
  flushIntervalMs?: number;
  maxRetries?: number;
  onError?: (error: Error) => void;
  maxQueueSize?: number;
  dropPolicy?: 'oldest' | 'newest';
  onDrop?: (event: EventInput) => void;
}
export class Logbird {
  private readonly queue: EventInput[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: Promise<void> | undefined;
  private closed = false;
  private readonly batchSize: number;
  private readonly interval: number;
  private readonly retries: number;
  private readonly capacity: number;
  private droppedCount = 0;
  get dropped(): number {
    return this.droppedCount;
  }
  get queueSize(): number {
    return this.queue.length;
  }
  private drop(event: EventInput) {
    this.droppedCount++;
    try {
      this.options.onDrop?.(event);
    } catch {
      /* Diagnostics cannot break capture. */
    }
  }
  constructor(private readonly options: LogbirdOptions) {
    if (options.enabled !== false && (!options.apiKey || !options.endpoint)) throw new Error('apiKey and endpoint are required when enabled');
    this.capacity = options.maxQueueSize ?? 10_000;
    this.batchSize = options.batchSize ?? 100;
    this.interval = options.flushIntervalMs ?? 1000;
    this.retries = options.maxRetries ?? 5;
    if (
      !Number.isInteger(this.capacity) ||
      this.capacity < 1 ||
      (options.dropPolicy !== undefined && !['oldest', 'newest'].includes(options.dropPolicy)) ||
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
    if (this.options.enabled === false) return;
    try {
      if (this.closed) throw new Error('Logbird is shut down');
      const defaults = this.options.defaults;
      let prepared: EventInput = {
        ...defaults,
        ...event,
        context: { ...defaults?.context, ...event.context },
        metadata: { ...defaults?.metadata, ...event.metadata },
      };
      prepared.id ??= uuidv7();
      prepared.occurredAt ??= new Date().toISOString();
      if (this.options.beforeSend) {
        const result = this.options.beforeSend(prepared);
        if (result == null) return;
        prepared = result;
      }
      const serialized = JSON.stringify(prepared);
      if (new TextEncoder().encode(serialized).length > 256 * 1024) throw new Error('Event exceeds 256 KB');
      const copy = JSON.parse(serialized) as EventInput;
      if (this.queue.length >= this.capacity) {
        if (this.options.dropPolicy === 'newest') {
          this.drop(copy);
          return;
        }
        this.drop(this.queue.shift()!);
      }
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
        response = await fetch(`${this.options.endpoint!.replace(/\/$/, '')}/v1/events`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.options.apiKey}`, 'Content-Type': 'application/json', 'X-Logbird-SDK': 'typescript/0.2.0' },
          body,
          signal: AbortSignal.timeout(30_000),
        });
      } catch (e) {
        error = e;
      }
      if (response?.ok) {
        const result = (await response.json()) as { rejected?: { index: number; reason: string }[] };
        if (result.rejected?.length) {
          for (const rejection of result.rejected) {
            const event = batch[rejection.index];
            if (event) this.drop(event);
          }
          this.report(new Error(`${result.rejected.length} events rejected by Logbird: ${result.rejected.map((r) => r.reason).join('; ')}`));
        }
        return;
      }
      const retry = !response || response.status === 429 || response.status >= 500;
      if (!retry) {
        for (const event of batch) this.drop(event);
        this.report(new Error(`Logbird HTTP ${response?.status}; batch dropped`));
        return;
      }
      if (attempt >= this.retries) throw error ?? new Error(`Logbird HTTP ${response?.status}`);
      const retryAfter = response?.headers.get('Retry-After');
      const seconds = retryAfter ? Number(retryAfter) : Number.NaN;
      const delay = Number.isFinite(seconds) ? seconds * 1000 : Math.min(30_000, 250 * 2 ** attempt) * (0.5 + Math.random());
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(60_000, delay))));
    }
  }
  flush(): Promise<void> {
    if (this.options.enabled === false) return Promise.resolve();
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
          while (this.queue.length > this.capacity) {
            this.drop(this.options.dropPolicy === 'newest' ? this.queue.pop()! : this.queue.shift()!);
          }
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

export const DEFAULT_SECRET_KEYS = /passw(or)?d|secret|token|otp|api[-_]?key|authorization|cookie|credential|private[-_]?key/i;
/** Redact a deep copy; combine this hook with application-specific filtering as needed. */
export function redact(options: { keys?: RegExp; changeFields?: RegExp; replacement?: string } = {}): (event: EventInput) => EventInput {
  const keys = options.keys ?? DEFAULT_SECRET_KEYS;
  const fields = options.changeFields ?? keys;
  const replacement = options.replacement ?? '[redacted]';
  const matches = (pattern: RegExp, key: string) => {
    pattern.lastIndex = 0;
    return pattern.test(key);
  };
  return (event) => {
    const copy = structuredClone(event);
    function walk(value: unknown, top = false): void {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (top && (key === 'id' || key === 'action')) continue;
        if (matches(keys, key)) (value as Record<string, unknown>)[key] = replacement;
        else walk(child);
      }
    }
    for (const change of copy.changes ?? []) {
      if (!matches(fields, change.field)) continue;
      if (Object.hasOwn(change, 'before')) change.before = replacement;
      if (Object.hasOwn(change, 'after')) change.after = replacement;
    }
    walk(copy, true);
    return copy;
  };
}
