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

type Level = 'nested' | 'top' | 'actor' | 'impersonator' | 'executor' | 'tenant' | 'targets' | 'target';

const IDENTITY: Record<Level, readonly string[]> = {
  nested: [],
  top: ['id', 'action'],
  actor: ['id', 'type'],
  impersonator: ['id'],
  executor: ['id', 'type', 'jobId', 'attempt'],
  tenant: ['id'],
  targets: [],
  target: ['id', 'type'],
};

const PARTIES: Record<string, Level> = { actor: 'actor', impersonator: 'impersonator', executor: 'executor', tenant: 'tenant', targets: 'targets' };

/**
 * Redact a deep copy; combine this hook with application-specific filtering as needed.
 *
 * A key matches when the pattern matches any part of it (the default redacts `tokenCount` and `secretary` too); anchor
 * your own pattern (`/^name$/`) to match whole keys. A matching key keeps its name and its value becomes the replacement,
 * at any depth. Identity is never redacted: the top-level `id` and `action`, and {@link IDENTIFIER_FIELDS}. A pattern
 * that matches a party's own key (`actor`, `impersonator`, `executor`, `tenant` or `targets`), or a target's index, redacts
 * every other field of that party and keeps its identifier fields; the party is never replaced as a whole. A change's
 * values are replaced when its `field` is a string the change pattern matches.
 *
 * The .NET SDK's `Redactor` follows the same rules, checked against one shared fixture: with the default pattern (and
 * names added like the .NET `AddKeys`), both redact exactly the same keys. A pattern of your own runs on each platform's
 * regular-expression engine, which can differ at the edges (in .NET, `$` also matches before a final line feed; flags
 * such as `i` fold case differently), so keep custom patterns to plain alternatives and anchors that mean the same in
 * both. The deep copy uses `structuredClone`, which accepts nesting within the JavaScript engine's limits.
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
    const copy = structuredClone(event);
    // Change values first, as the .NET SDK does; the walk below may then replace a matching key holding them. Only an
    // object entry whose field is a string is matched (any other shape is left to the walk, never thrown on).
    const changes: unknown = copy.changes;
    if (Array.isArray(changes)) {
      for (const change of changes) {
        if (!change || typeof change !== 'object' || Array.isArray(change)) continue;
        const entry = change as Record<string, unknown>;
        if (typeof entry.field !== 'string' || !matches(fields, entry.field)) continue;
        if (Object.hasOwn(entry, 'before')) entry.before = replacement;
        if (Object.hasOwn(entry, 'after')) entry.after = replacement;
      }
    }
    // Iterative, like the .NET SDK, so the walk itself never recurses (the deep copy is structuredClone's, within the
    // engine's limits). Each decision depends only on the node's own key and level, so the visiting order does not change
    // the result.
    const pending: Array<{ node: unknown; level: Level; whole: boolean }> = [{ node: copy, level: 'top', whole: false }];
    while (pending.length > 0) {
      const { node, level, whole } = pending.pop()!;
      if (!node || typeof node !== 'object') continue;
      const record = node as Record<string, unknown>;
      if (Array.isArray(node) && level === 'targets') {
        // Target entries are parties: never replaced as a whole, and their type and id are kept. A pattern matching an
        // entry's index (or the targets key) redacts the entry's other fields; a scalar entry is replaced.
        node.forEach((entry, index) => {
          const matched = whole || matches(keys, String(index));
          if (entry && typeof entry === 'object' && !Array.isArray(entry)) pending.push({ node: entry, level: 'target', whole: matched });
          else if (matched) node[index] = replacement;
          else pending.push({ node: entry, level: 'nested', whole: false });
        });
        continue;
      }
      // Arrays are walked by their index keys ("0", "1", ...), as Object.entries gives them.
      for (const [key, child] of Object.entries(record)) {
        if (IDENTITY[level].includes(key)) continue;
        if (whole) {
          record[key] = replacement;
          continue;
        }
        const party = level === 'top' && Object.hasOwn(PARTIES, key) ? PARTIES[key]! : 'nested';
        const matched = matches(keys, key);
        const isParty =
          party !== 'nested' && (party === 'targets' ? Array.isArray(child) : !!child && typeof child === 'object' && !Array.isArray(child));
        if (isParty) pending.push({ node: child, level: party, whole: matched });
        else if (matched) record[key] = replacement;
        else pending.push({ node: child, level: 'nested', whole: false });
      }
    }
    return copy;
  };
}
