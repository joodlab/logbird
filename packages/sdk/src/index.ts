export {
  generateWebhookSecret,
  MAX_WEBHOOK_SIGNATURES,
  type SignWebhookOptions,
  signWebhook,
  type VerifyWebhookOptions,
  verifyWebhook,
  type WebhookHeaders,
  WebhookVerificationError,
  type WebhookVerificationReason,
} from './webhooks';

// Keep in sync with packages/sdk/package.json (verified by index.test.ts).
const SDK_VERSION = '0.2.1';
const MAX_SEND_MS = 5 * 60_000;

/**
 * A string id, or a JavaScript number from an integer key. A JS number cannot hold integers above 2^53 − 1: send
 * 64-bit ids as strings. The server indexes a numeric id as the plain decimal of its value.
 */
export type EntityId = string | number;
/** Copied structural envelope: no runtime or workspace dependency in the published SDK. */
export interface EventInput {
  action: string;
  id?: string;
  occurredAt?: string | number;
  environment?: string;
  outcome?: string;
  severity?: string;
  description?: string;
  actor?: { type?: string; id?: EntityId; name?: string; email?: string; [key: string]: unknown };
  impersonator?: { id?: EntityId; name?: string; [key: string]: unknown };
  executor?: { type?: string; id?: EntityId; name?: string; jobId?: EntityId; attempt?: number; [key: string]: unknown };
  tenant?: { id: EntityId; name?: string; [key: string]: unknown };
  source?: string;
  targets?: { type: string; id: EntityId; name?: string; [key: string]: unknown }[];
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
const monotonicNow = (): number => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now());
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
      // The server mints a fresh id for a missing, blank or non-string id (numbers included), which a retry could
      // never match. Mint it here instead, on a copy, so a frozen or caller-owned beforeSend result is never mutated.
      if (typeof prepared.id !== 'string' || !prepared.id.trim()) prepared = { ...prepared, id: uuidv7() };
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
    // Monotonic: a wall-clock step (NTP, suspend, a test clock) must not shorten or extend the send cap.
    const deadline = monotonicNow() + MAX_SEND_MS;
    const serialized = batch.map((event) => JSON.stringify(event));
    let attemptIndices = batch.map((_, index) => index);
    const serializeBody = () => `{"events":[${attemptIndices.map((index) => serialized[index]).join(',')}]}`;
    let body = serializeBody();
    const settledIndices = new Set<number>();
    const reject = (rejections: unknown) => {
      if (!Array.isArray(rejections)) return;
      const fresh: { index: number; reason: string }[] = [];
      for (const rejection of rejections) {
        if (!rejection || typeof rejection !== 'object' || !Number.isInteger(rejection.index) || typeof rejection.reason !== 'string') continue;
        const index = attemptIndices[rejection.index];
        if (index === undefined || settledIndices.has(index)) continue;
        settledIndices.add(index);
        fresh.push(rejection);
        this.drop(batch[index]!);
      }
      if (fresh.length) this.report(new Error(`${fresh.length} events rejected by Logbird: ${fresh.map((r) => r.reason).join('; ')}`));
    };
    let retries = 0;
    try {
      for (let attempt = 0; ; attempt++) {
        const remainingMs = deadline - monotonicNow();
        if (remainingMs <= 0) throw new Error('Logbird send exceeded its five-minute time limit');
        let progressed = false;
        let response: Response | undefined, error: unknown;
        try {
          response = await fetch(`${this.options.endpoint!.replace(/\/$/, '')}/v1/events`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${this.options.apiKey}`,
              'Content-Type': 'application/json',
              'X-Logbird-SDK': `typescript/${SDK_VERSION}`,
              // Must equal @logbird/contracts LOGBIRD_RETRY_HEADER / LOGBIRD_RETRY_SUBSET (the SDK has no dependencies).
              'Logbird-Retry': 'subset',
            },
            body,
            // AbortSignal.timeout() accepts integers only; the monotonic clock is fractional.
            signal: AbortSignal.timeout(Math.max(1, Math.floor(Math.min(30_000, remainingMs)))),
          });
        } catch (e) {
          error = e;
        }
        if (response?.ok) {
          const result = (await response.json()) as { rejected?: { index: number; reason: string }[] };
          reject(result.rejected);
          return;
        }
        if (response?.status === 503) {
          // Retry the identical body unless the server settled rows; then resend only unsettled rows.
          const result = (await response.json().catch(() => null)) as {
            error?: {
              code?: string;
              details?: {
                accepted?: number;
                ids?: string[];
                rejected?: { index: number; reason: string }[];
                indices?: number[];
                eventIds?: string[];
                warnings?: unknown[];
              };
            };
          } | null;
          if (result?.error?.code === 'ingest_pending' || result?.error?.code === 'ingest_unavailable') {
            const details = result.error.details;
            reject(details?.rejected);
            if (
              details &&
              Array.isArray(details.ids) &&
              details.ids.every((id) => typeof id === 'string') &&
              details.accepted === details.ids.length &&
              Array.isArray(details.rejected) &&
              details.rejected.every(
                (r) =>
                  r && typeof r === 'object' && Number.isInteger(r.index) && attemptIndices[r.index] !== undefined && typeof r.reason === 'string',
              ) &&
              Array.isArray(details.indices) &&
              details.indices.every((index) => Number.isInteger(index) && attemptIndices[index] !== undefined) &&
              Array.isArray(details.eventIds) &&
              details.eventIds.every((id) => typeof id === 'string') &&
              details.indices.length === details.eventIds.length &&
              new Set(details.indices).size === details.indices.length &&
              new Set(details.rejected.map((r) => r.index)).size === details.rejected.length &&
              details.indices.every((index, position) => {
                const id = batch[attemptIndices[index]!]!.id;
                return typeof id === 'string' && details.eventIds?.[position] === id.trim() && !details.rejected?.some((r) => r.index === index);
              }) &&
              Array.isArray(details.warnings)
            ) {
              const accepted = new Set(details.ids);
              const unresolved = new Set(details.indices);
              attemptIndices.forEach((index, wireIndex) => {
                const event = batch[index]!;
                if (!unresolved.has(wireIndex) && typeof event.id === 'string' && accepted.has(event.id.trim())) settledIndices.add(index);
              });
              // Require every omitted position to be settled; malformed details must keep the previous body.
              if (attemptIndices.every((index, wireIndex) => unresolved.has(wireIndex) || settledIndices.has(index))) {
                const remaining = attemptIndices.filter((index) => !settledIndices.has(index));
                if (!remaining.length) return;
                if (remaining.length < attemptIndices.length) {
                  attemptIndices = remaining;
                  body = serializeBody();
                  progressed = true;
                }
              }
            }
          }
        }
        const retry = !response || response.status === 429 || response.status >= 500;
        if (!retry) {
          batch.forEach((event, index) => {
            if (!settledIndices.has(index)) this.drop(event);
          });
          this.report(new Error(`Logbird HTTP ${response?.status}; batch dropped`));
          return;
        }
        // Progress attempts strictly shrink the body, so there can be at most batch.length of them.
        // Only non-progress failures consume maxRetries; retain a hard total-attempt bound as well.
        if ((!progressed && retries >= this.retries) || attempt >= batch.length + this.retries - 1)
          throw error ?? new Error(`Logbird HTTP ${response?.status}`);
        const retryAfter = response?.headers.get('Retry-After');
        const seconds = retryAfter ? Number(retryAfter) : Number.NaN;
        const delay = Number.isFinite(seconds) ? seconds * 1000 : Math.min(30_000, 250 * 2 ** retries) * (0.5 + Math.random());
        if (!progressed) retries++;
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(60_000, delay, deadline - monotonicNow()))));
      }
    } finally {
      // On every exceptional exit, flush can requeue only events not already accepted or rejected.
      const remaining = batch.filter((_, index) => !settledIndices.has(index));
      batch.splice(0, batch.length, ...remaining);
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
/**
 * The parties' identifier and classification fields: never redacted, whatever the pattern. A redacted id would merge
 * every identity into one, and an executor's attempt must stay a number. To pseudonymise an id, transform it before
 * recording. The .NET SDK's `Redactor.IdentifierFields` lists the same fields.
 */
export const IDENTIFIER_FIELDS: readonly string[] = Object.freeze([
  'actor.type',
  'actor.id',
  'impersonator.id',
  'executor.type',
  'executor.id',
  'executor.jobId',
  'executor.attempt',
  'tenant.id',
  'targets[].type',
  'targets[].id',
]);

type Level = 'nested' | 'top' | 'actor' | 'impersonator' | 'executor' | 'tenant' | 'targets' | 'target' | 'changes' | 'change' | 'plain';

const IDENTITY: Record<Level, readonly string[]> = {
  nested: [],
  top: ['id', 'action'],
  actor: ['id', 'type'],
  impersonator: ['id'],
  executor: ['id', 'type', 'jobId', 'attempt'],
  tenant: ['id'],
  targets: [],
  target: ['id', 'type'],
  changes: [],
  change: [],
  plain: [],
};

const PARTIES: Record<string, Level> = { actor: 'actor', impersonator: 'impersonator', executor: 'executor', tenant: 'tenant', targets: 'targets' };

/**
 * Redact a deep copy; combine this hook with application-specific filtering as needed.
 *
 * A key matches when the pattern matches any part of it (the default redacts `tokenCount` and `secretary` too); anchor
 * your own pattern (`/^name$/`) to match whole keys. A matching key keeps its name and its value becomes the replacement,
 * at any depth. Identity is never redacted: the top-level `id` and `action`, and {@link IDENTIFIER_FIELDS}. A pattern
 * that matches a party's own key (`actor`, `impersonator`, `executor`, `tenant` or `targets`), or a target's index, redacts
 * every other field of that party and keeps its identifier fields; a party object is never replaced as a whole (one that
 * is not an object is replaced like any other value). A change's
 * values are replaced when its `field` is a string the change pattern matches.
 *
 * The .NET SDK's `Redactor` follows the same rules, checked against one shared fixture: with the default pattern (and
 * names added like the .NET `AddKeys`), both redact exactly the same keys. A pattern of your own runs on each platform's
 * regular-expression engine, which can differ at the edges (in .NET, `$` also matches before a final line feed; flags
 * such as `i` fold case differently), so keep custom patterns to plain alternatives and anchors that mean the same in
 * both. It returns the event as JSON will send it, built in one pass: a matched key's value is replaced without being
 * read (so a value JSON cannot hold, such as a `BigInt` under a secret key, never stops the event), `toJSON` is applied
 * (a `Date` becomes its ISO string), values JSON leaves out are left out, an object reached twice becomes two copies, and
 * an event with a cycle throws a `TypeError`, as serializing it would.
 */
export function redact(options: { keys?: RegExp; changeFields?: RegExp; replacement?: string } = {}): (event: EventInput) => EventInput {
  const keys = options.keys ?? DEFAULT_SECRET_KEYS;
  const fields = options.changeFields ?? keys;
  const replacement = options.replacement ?? '[redacted]';
  const matches = (pattern: RegExp, key: string) => {
    pattern.lastIndex = 0;
    return pattern.test(key);
  };
  return (event) => {
    // One pass builds the copy and redacts it, the event as JSON will send it (the tree the .NET SDK redacts). It is
    // iterative, so it never recurses. A matched value is replaced without being read. A child decision depends only on
    // its own key, its parent's level and the source, so the visiting order does not change the result.
    type Frame =
      | { exit: false; value: unknown; key: string; level: Level; whole: boolean; changed: boolean; set: (value: unknown) => void }
      | { exit: true; source: object };
    const active = new Set<object>();
    let result: unknown;
    const stack: Frame[] = [
      {
        exit: false,
        value: event,
        key: '',
        level: 'top',
        whole: false,
        changed: false,
        set: (value) => {
          result = value;
        },
      },
    ];
    const omitted = (value: unknown) => value === undefined || typeof value === 'function' || typeof value === 'symbol';
    const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
    while (stack.length > 0) {
      const frame = stack.pop()!;
      if (frame.exit) {
        active.delete(frame.source);
        continue;
      }
      let value = frame.value;
      if (value && typeof value === 'object' && typeof (value as { toJSON?: unknown }).toJSON === 'function') {
        value = (value as { toJSON: (key: string) => unknown }).toJSON(frame.key);
      }
      if (!value || typeof value !== 'object') {
        frame.set(value);
        continue;
      }
      if (active.has(value)) throw new TypeError('redact(): the event has a cycle, so it cannot be sent as JSON.');
      active.add(value);
      const { level, whole, changed } = frame;
      // Children are pushed last to first, so each is copied in order and keys keep their order.
      const children: Frame[] = [];
      const child = (value: unknown, key: string, childLevel: Level, childWhole: boolean, childChanged: boolean, set: (v: unknown) => void) =>
        children.push({ exit: false, value, key, level: childLevel, whole: childWhole, changed: childChanged, set });
      if (Array.isArray(value)) {
        const out: unknown[] = new Array(value.length).fill(null);
        frame.set(out);
        const put = (index: number) => (v: unknown) => {
          out[index] = omitted(v) ? null : v;
        };
        for (let index = 0; index < value.length; index++) {
          const entry: unknown = value[index];
          const key = String(index);
          if (level === 'plain') {
            child(entry, key, 'plain', false, false, put(index));
          } else if (level === 'targets') {
            // Target entries are parties: never replaced as a whole, and their type and id are kept. A pattern matching
            // an entry's index (or the targets key) redacts the entry's other fields; a scalar entry is replaced.
            const matched = whole || matches(keys, key);
            if (isObject(entry)) child(entry, key, 'target', matched, false, put(index));
            else if (matched) put(index)(replacement);
            else child(entry, key, 'nested', false, false, put(index));
          } else if (matches(keys, key)) {
            // Arrays are matched by their index keys ("0", "1", ...), as Object.entries gives them.
            put(index)(replacement);
          } else if (level === 'changes' && isObject(entry)) {
            // Change values are decided on the field as recorded; only an object entry with a string field is matched.
            child(entry, key, 'change', false, typeof entry.field === 'string' && matches(fields, entry.field), put(index));
          } else {
            child(entry, key, 'nested', false, false, put(index));
          }
        }
      } else {
        const out: Record<string, unknown> = {};
        frame.set(out);
        const put = (key: string) => (v: unknown) => {
          if (!omitted(v)) out[key] = v;
          else delete out[key];
        };
        for (const [key, entry] of Object.entries(value)) {
          // Reserve the key's place, so the copy keeps the source's order; a value JSON leaves out is removed again.
          out[key] = undefined;
          if (level === 'plain' || IDENTITY[level].includes(key)) {
            child(entry, key, 'plain', false, false, put(key));
            continue;
          }
          if (whole || (changed && (key === 'before' || key === 'after'))) {
            put(key)(omitted(entry) ? undefined : replacement);
            continue;
          }
          const party = level === 'top' && Object.hasOwn(PARTIES, key) ? PARTIES[key]! : 'nested';
          const matched = matches(keys, key);
          const isParty = party !== 'nested' && (party === 'targets' ? Array.isArray(entry) : isObject(entry));
          if (isParty) child(entry, key, party, matched, false, put(key));
          else if (matched) put(key)(omitted(entry) ? undefined : replacement);
          else child(entry, key, level === 'top' && key === 'changes' && Array.isArray(entry) ? 'changes' : 'nested', false, false, put(key));
        }
      }
      stack.push({ exit: true, source: value });
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
    }
    return result as EventInput;
  };
}
