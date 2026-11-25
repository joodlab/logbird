import { acknowledge } from './acknowledgement';
import { attachCaptureQueue } from './capture-queue';
import { LogbirdError, safeDiagnostic } from './errors';
import { checkEventBounds, inputBoundReason, stringifyEvent } from './event-bounds';
import { type LogbirdWarning, partyWarnings } from './party-warnings';
import { createRedactor, type RedactionOptions } from './redaction';
import { ACKNOWLEDGEMENT_BYTES, cancelBody, isRedirect, readJson } from './response';

export { LogbirdError, type LogbirdErrorCode, type LogbirdErrorDetails } from './errors';
export type { LogbirdWarning } from './party-warnings';

export { DEFAULT_SECRET_KEYS, IDENTIFIER_FIELDS, type RedactionOptions, redact } from './redaction';
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
const SDK_VERSION = '0.3.0';
const MAX_SEND_MS = 5 * 60_000;
const MAX_PENDING_NOTIFICATIONS = 1024;
const MAX_OUTSTANDING_REQUESTS = 4;

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
export type IngestRejectionCode =
  | 'invalid_event'
  | 'invalid_event_id'
  | 'duplicate_id_conflict'
  | 'stored_event_unreadable'
  | 'unverified_after_parse_failure';

export type DropReason =
  | 'queue_full'
  | 'rejected'
  | 'http_error'
  | 'too_large'
  | 'input_too_large'
  | 'input_too_deep'
  | 'invalid'
  | 'before_send_failed'
  | 'redaction_failed'
  | 'filtered'
  | 'diagnostic_reentry'
  | 'shutdown';

export interface DropDetails {
  reason: DropReason;
  /** A dispatch may have stored this event. Replay with the original id and content. */
  mayBeStored: boolean;
  code?: IngestRejectionCode;
  status?: number;
}

export interface TrackOptions {
  /** Preserve a nonblank event id already returned to the caller, even if beforeSend changes it. */
  preserveId?: boolean;
}

export interface LogbirdOptions {
  apiKey?: string;
  endpoint?: string;
  enabled?: boolean;
  defaults?: Partial<EventInput>;
  beforeSend?: (event: EventInput) => EventInput | null | undefined;
  /** Redacts events after beforeSend and before the size limit. Defaults to the built-in secret-key rules. */
  redaction?: false | RedactionOptions;
  batchSize?: number;
  flushIntervalMs?: number;
  /** Total delivery time allowed at shutdown, including any request already in progress. Defaults to 10 seconds. */
  shutdownTimeoutMs?: number;
  maxRetries?: number;
  onError?: (error: LogbirdError) => void;
  onWarning?: (warning: Readonly<LogbirdWarning>) => void;
  maxQueueSize?: number;
  dropPolicy?: 'oldest' | 'newest';
  onDrop?: (event: EventInput, details: Readonly<DropDetails>) => void;
}

interface QueuedEvent {
  event: EventInput;
  sequence: number;
  wireId: string;
  serialized: string;
  bytes: number;
  uncertain: boolean;
  sending: boolean;
}

interface FlushWaiter {
  promise: Promise<void>;
  resolve: (result?: void | Promise<void>) => void;
  reject: (error: unknown) => void;
}

interface PreparingEvent {
  identity: EventInput;
  done: Promise<void>;
  finish: () => void;
}

function boundedIdentityText(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  if (value.length <= 256) return value;
  // Copy the prefix because a substring can keep the entire original string alive.
  return String.fromCharCode(...Array.from({ length: 256 }, (_, index) => value.charCodeAt(index)));
}

function dropIdentity(event: EventInput): EventInput {
  // Local refusals may not have a usable snapshot. Do not copy invalid or oversized inputs into the notification backlog.
  try {
    const action: unknown = Object.getOwnPropertyDescriptor(event, 'action')?.value;
    const id: unknown = Object.getOwnPropertyDescriptor(event, 'id')?.value;
    return { action: boundedIdentityText(action) ?? '', id: boundedIdentityText(id) };
  } catch {
    return { action: '' };
  }
}

export class Logbird {
  private readonly queue: QueuedEvent[] = [];
  private inFlight: QueuedEvent[] = [];
  private lastSequence = 0;
  private flushWaiters = new Map<number, FlushWaiter>();
  private readonly preparing = new Set<PreparingEvent>();
  private readonly options: LogbirdOptions;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private operationTimer: ReturnType<typeof setTimeout> | undefined;
  private pending: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;
  private shutdownDeadline: number | undefined;
  private explicit = false;
  private readonly stop = new AbortController();
  private closed = false;
  private readonly batchSize: number;
  private readonly interval: number;
  private readonly shutdownTimeout: number;
  private readonly endpoint: string;
  private readonly retries: number;
  private readonly capacity: number;
  private readonly serializeRedacted: ReturnType<typeof createRedactor> | undefined;
  private droppedCount = 0;
  private readonly dropCounts: Partial<Record<DropReason, number>> = {};
  private readonly uncertainDropCounts: Partial<Record<DropReason, number>> = {};
  private notifications = 0;
  private notificationBurst = 0;
  private notifying = false;
  private outstandingRequests = 0;
  private skipped = 0;
  private failed = 0;
  get dropped(): number {
    return this.droppedCount;
  }
  get droppedByReason(): Readonly<Partial<Record<DropReason, number>>> {
    return { ...this.dropCounts };
  }
  get possiblyStoredDropsByReason(): Readonly<Partial<Record<DropReason, number>>> {
    return { ...this.uncertainDropCounts };
  }
  get skippedNotifications(): number {
    return this.skipped;
  }
  get failedNotifications(): number {
    return this.failed;
  }
  get queueSize(): number {
    return this.queue.length;
  }
  private notify<T extends unknown[]>(callback: ((...args: T) => void) | undefined, ...args: T) {
    if (!callback) return;
    if (this.notifying || this.notifications >= MAX_PENDING_NOTIFICATIONS || this.notificationBurst >= MAX_PENDING_NOTIFICATIONS) {
      this.skipped++;
      return;
    }
    if (this.notificationBurst === 0) {
      // A callback that captures again after an await must still yield the event loop to the shutdown timer.
      setTimeout(() => {
        this.notificationBurst = 0;
      }, 0).unref?.();
    }
    this.notificationBurst++;
    this.notifications++;
    void Promise.resolve()
      .then(() => {
        this.notifying = true;
        try {
          return callback(...args);
        } finally {
          this.notifying = false;
        }
      })
      .then(
        () => {
          this.notifications--;
        },
        () => {
          this.notifications--;
          this.failed++;
        },
      );
  }
  private drop(event: EventInput, details: DropDetails) {
    this.droppedCount++;
    this.dropCounts[details.reason] = (this.dropCounts[details.reason] ?? 0) + 1;
    if (details.mayBeStored) this.uncertainDropCounts[details.reason] = (this.uncertainDropCounts[details.reason] ?? 0) + 1;
    this.notify(this.options.onDrop, event, details);
  }
  private dropQueued(entry: QueuedEvent, reason: DropReason, extra?: Pick<DropDetails, 'code' | 'status'>) {
    this.drop(entry.event, { reason, mayBeStored: entry.sending || entry.uncertain, ...extra });
  }
  constructor(options: LogbirdOptions) {
    const snapshot: LogbirdOptions = {
      apiKey: options.apiKey,
      endpoint: options.endpoint,
      enabled: options.enabled,
      defaults: options.defaults,
      beforeSend: options.beforeSend,
      redaction: options.redaction,
      batchSize: options.batchSize,
      flushIntervalMs: options.flushIntervalMs,
      shutdownTimeoutMs: options.shutdownTimeoutMs,
      maxRetries: options.maxRetries,
      onError: options.onError,
      onWarning: options.onWarning,
      maxQueueSize: options.maxQueueSize,
      dropPolicy: options.dropPolicy,
      onDrop: options.onDrop,
    };
    if (snapshot.enabled !== false && (!snapshot.apiKey || !snapshot.endpoint)) throw new LogbirdError('credentials_required');
    this.endpoint = (snapshot.endpoint ?? '').replace(/\/$/, '');
    this.capacity = snapshot.maxQueueSize ?? 10_000;
    this.batchSize = snapshot.batchSize ?? 100;
    this.interval = snapshot.flushIntervalMs ?? 1000;
    this.shutdownTimeout = snapshot.shutdownTimeoutMs ?? 10_000;
    this.retries = snapshot.maxRetries ?? 5;
    if (
      !Number.isInteger(this.capacity) ||
      this.capacity < 1 ||
      (snapshot.dropPolicy !== undefined && !['oldest', 'newest'].includes(snapshot.dropPolicy)) ||
      !Number.isInteger(this.batchSize) ||
      this.batchSize < 1 ||
      this.batchSize > 1000 ||
      !Number.isFinite(this.interval) ||
      this.interval < 1 ||
      !Number.isInteger(this.shutdownTimeout) ||
      this.shutdownTimeout < 0 ||
      this.shutdownTimeout > 3_600_000 ||
      !Number.isInteger(this.retries) ||
      this.retries < 0
    )
      throw new LogbirdError('options_invalid');
    this.options = snapshot;
    attachCaptureQueue(this, {
      defer: (identity, prepare, onFailure) => this.deferCapture(identity, prepare, onFailure),
      notify: (callback, error) => this.notify(callback, safeDiagnostic(error, 'capture_failed')),
    });
    if (snapshot.redaction !== false) {
      this.serializeRedacted = createRedactor(snapshot.redaction, (error) => this.report(error));
    }
  }
  private report(error: unknown) {
    this.notify(this.options.onError, safeDiagnostic(error, 'ingest_request_failed'));
  }
  private refuse(event: EventInput, reason: DropReason, error?: LogbirdError) {
    this.drop(dropIdentity(event), { reason, mayBeStored: false });
    if (error) this.report(error);
  }
  track(event: EventInput, options?: TrackOptions): void {
    this.trackPrepared(event, options, false);
  }
  private trackPrepared(event: EventInput, options: TrackOptions | undefined, duringShutdown: boolean): void {
    if (this.options.enabled === false) return;
    if (this.notifying) {
      this.refuse(event, 'diagnostic_reentry');
      return;
    }
    if (this.closed && !duringShutdown) {
      this.refuse(event, 'shutdown', new LogbirdError('client_closed'));
      return;
    }
    let entry: Omit<QueuedEvent, 'sequence'>;
    let failure: DropReason = 'invalid';
    let identity = dropIdentity(event);
    try {
      const defaults = this.options.defaults;
      checkEventBounds(event);
      if (defaults) checkEventBounds(defaults);
      let prepared: EventInput = { ...defaults, ...event };
      const id = typeof prepared.id === 'string' && prepared.id.trim() ? prepared.id : uuidv7();
      prepared.id = id;
      identity = dropIdentity(prepared);
      prepared.context = { ...defaults?.context, ...event.context };
      prepared.metadata = { ...defaults?.metadata, ...event.metadata };
      prepared.occurredAt ??= new Date().toISOString();
      if (defaults || this.options.beforeSend) checkEventBounds(prepared);
      if (this.options.beforeSend) {
        failure = 'before_send_failed';
        const result = this.options.beforeSend(prepared);
        if (result == null) {
          this.refuse(identity, 'filtered');
          return;
        }
        if (typeof result.then === 'function') {
          // beforeSend prepares the event synchronously. Observe an accidental async return without queuing it.
          void Promise.resolve(result).catch(() => undefined);
          this.refuse(identity, 'before_send_failed', new LogbirdError('before_send_failed'));
          return;
        }
        prepared = result;
        failure = 'invalid';
        checkEventBounds(prepared);
      }
      const supplied: unknown = prepared.id;
      const hookId = typeof supplied === 'string' && supplied.trim() ? supplied : undefined;
      const outgoingId = options?.preserveId ? id : (hookId ?? uuidv7());
      if (supplied !== outgoingId) prepared = { ...prepared, id: outgoingId };
      // The serialized snapshot also enforces the id for events with a top-level toJSON.
      if (this.serializeRedacted) failure = 'redaction_failed';
      let serialized = this.serializeRedacted ? this.serializeRedacted(prepared) : stringifyEvent(prepared);
      failure = 'invalid';
      let bytes = new TextEncoder().encode(serialized).length;
      if (bytes > 256 * 1024) {
        this.refuse(identity, 'too_large', new LogbirdError('event_too_large'));
        return;
      }
      const copy = JSON.parse(serialized) as EventInput;
      if (!copy || typeof copy !== 'object' || Array.isArray(copy)) {
        this.refuse(identity, 'invalid', new LogbirdError('event_invalid'));
        return;
      }
      if (typeof copy.id !== 'string' || !copy.id.trim() || (options?.preserveId && copy.id !== outgoingId)) {
        copy.id = outgoingId;
        serialized = JSON.stringify(copy);
        bytes = new TextEncoder().encode(serialized).length;
        if (bytes > 256 * 1024) {
          this.refuse(identity, 'too_large', new LogbirdError('event_too_large'));
          return;
        }
      }
      entry = { event: copy, wireId: copy.id.trim(), serialized, bytes, uncertain: false, sending: false };
    } catch (error) {
      const bound = failure === 'before_send_failed' ? undefined : inputBoundReason(error);
      if (bound) {
        this.refuse(identity, bound, new LogbirdError(bound));
      } else {
        const code = failure === 'before_send_failed' || failure === 'redaction_failed' ? failure : 'event_invalid';
        this.refuse(identity, failure, new LogbirdError(code));
      }
      return;
    }
    // beforeSend is host code and can shut down the client before preparation returns.
    if (this.closed && (!duringShutdown || this.stop.signal.aborted)) {
      this.drop(entry.event, { reason: 'shutdown', mayBeStored: false });
      return;
    }
    if (!this.makeRoom()) {
      this.drop(entry.event, { reason: 'queue_full', mayBeStored: false });
      return;
    }
    this.queue.push({ ...entry, sequence: ++this.lastSequence });
    if (this.options.onWarning) {
      for (const warning of partyWarnings(entry.event)) this.notify(this.options.onWarning, warning);
    }
    if (this.queue.length >= this.batchSize) this.backgroundFlush();
    else this.schedule();
  }
  private makeRoom(): boolean {
    if (this.queue.length + this.preparing.size < this.capacity) return true;
    const evicted = this.options.dropPolicy === 'newest' ? undefined : this.queue.shift();
    if (!evicted) return false;
    this.dropQueued(evicted, 'queue_full');
    this.completeFlushes();
    return true;
  }
  private deferCapture(
    identity: EventInput,
    prepare: () => Promise<EventInput>,
    onFailure: (error: LogbirdError) => void,
  ): Promise<void> | undefined {
    if (this.notifying || this.closed || !this.makeRoom()) {
      if (this.options.enabled !== false) this.refuse(identity, this.notifying ? 'diagnostic_reentry' : this.closed ? 'shutdown' : 'queue_full');
      return;
    }
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const capture = { identity: dropIdentity(identity), done, finish };
    this.preparing.add(capture);
    const fail = (error: unknown) => {
      if (!this.preparing.delete(capture)) return;
      const bound = inputBoundReason(error);
      if (this.options.enabled !== false) this.refuse(capture.identity, bound ?? 'invalid');
      try {
        onFailure(new LogbirdError(bound ?? 'capture_failed'));
      } finally {
        finish();
      }
    };
    const settle = (event: EventInput) => {
      if (!this.preparing.delete(capture)) return;
      try {
        if (this.closed && this.options.enabled !== false) this.trackPrepared(event, { preserveId: true }, true);
        else this.track(event, { preserveId: true });
      } catch {
        if (this.options.enabled !== false) this.refuse(capture.identity, 'invalid');
        onFailure(new LogbirdError('capture_failed'));
      } finally {
        finish();
      }
    };
    void prepare()
      .then(settle, fail)
      .catch(() => undefined);
    return done;
  }
  private backgroundFlush() {
    if (this.pending) return;
    void this.drain(false).catch((error) => this.report(error));
  }
  private schedule() {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.backgroundFlush();
    }, this.interval);
    this.timer.unref?.();
  }
  private async timed<T>(milliseconds: number, timeout: () => T, operation?: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.stop.signal.throwIfAborted();
    const controller = new AbortController();
    const stop = () => controller.abort(this.stop.signal.reason);
    this.stop.signal.addEventListener('abort', stop, { once: true });
    try {
      return await new Promise<T>((resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
        this.operationTimer = setTimeout(() => {
          resolve(timeout());
          controller.abort();
        }, milliseconds);
        if (!this.explicit) this.operationTimer.unref?.();
        if (operation) void operation(controller.signal).then(resolve, reject);
      });
    } finally {
      clearTimeout(this.operationTimer);
      this.operationTimer = undefined;
      this.stop.signal.removeEventListener('abort', stop);
    }
  }
  private async request(batch: QueuedEvent[], remainingMs: number) {
    if (this.outstandingRequests >= MAX_OUTSTANDING_REQUESTS) throw new LogbirdError('ingest_requests_outstanding');
    const body = `{"events":[${batch.map((entry) => entry.serialized).join(',')}]}`;
    let status = 0;
    let retryAfter: string | null = null;
    let redirected = false;
    const answer = () => ({ status, retryAfter, redirected, result: undefined as unknown, bodyFailure: undefined as LogbirdError | undefined });
    try {
      return await this.timed(Math.max(1, Math.floor(Math.min(30_000, remainingMs))), answer, async (signal) => {
        let cancellation: Promise<void> | undefined;
        this.outstandingRequests++;
        try {
          this.checkShutdownDeadline();
          for (const entry of batch) entry.sending = true;
          const response = await fetch(`${this.endpoint}/v1/events`, {
            method: 'POST',
            redirect: 'manual',
            headers: {
              Authorization: `Bearer ${this.options.apiKey}`,
              'Content-Type': 'application/json',
              'X-Logbird-SDK': `typescript/${SDK_VERSION}`,
              // Must equal @logbird/contracts LOGBIRD_RETRY_HEADER / LOGBIRD_RETRY_SUBSET (the SDK has no dependencies).
              'Logbird-Retry': 'subset',
            },
            body,
            signal,
          });
          if (signal.aborted) {
            cancellation = cancelBody(response);
            return answer();
          }
          status = response.status;
          redirected = isRedirect(response);
          retryAfter = response.headers.get('Retry-After');
          if (redirected || (!response.ok && status !== 503)) {
            cancellation = cancelBody(response);
            return answer();
          }
          try {
            const result = await readJson(response, ACKNOWLEDGEMENT_BYTES, signal, (completion) => {
              cancellation = completion;
            });
            return { ...answer(), result };
          } catch (error) {
            return { ...answer(), bodyFailure: error instanceof LogbirdError ? error : undefined };
          }
        } finally {
          if (cancellation) {
            // Return the classification immediately but keep owning transport cleanup until it finishes.
            void cancellation.then(() => {
              this.outstandingRequests--;
            });
          } else this.outstandingRequests--;
        }
      });
    } catch {
      this.stop.signal.throwIfAborted();
      return answer();
    } finally {
      for (const entry of batch) {
        if (this.stop.signal.aborted && entry.sending && (status < 400 || status >= 500)) entry.uncertain = true;
        entry.sending = false;
      }
    }
  }
  private async send(batch: QueuedEvent[]) {
    const deadline = monotonicNow() + MAX_SEND_MS;
    const maxAttempts = batch.length + this.retries;
    let wire = batch.slice();
    const unsettled = new Set(batch);
    let retries = 0;
    for (let attempt = 1; ; attempt++) {
      this.checkShutdownDeadline();
      const remainingMs = deadline - monotonicNow();
      if (remainingMs <= 0) throw new LogbirdError('ingest_timeout');
      const { status, retryAfter, result, redirected, bodyFailure } = await this.request(wire, remainingMs);
      const success = status >= 200 && status < 300;
      let progressed = false;
      if (!this.stop.signal.aborted && (success || status === 503)) {
        const ack = acknowledge(
          result,
          wire.map((entry) => entry.wireId),
          status === 503,
        );
        if (ack) {
          let rejectedCount = 0;
          for (const [index, code] of ack.rejected) {
            const entry = wire[index];
            if (!entry || !unsettled.delete(entry)) continue;
            const definitive = code === 'invalid_event' || code === 'invalid_event_id' || code === 'duplicate_id_conflict';
            this.drop(entry.event, { reason: 'rejected', code, mayBeStored: entry.uncertain && !definitive });
            rejectedCount++;
          }
          if (rejectedCount) this.report(new LogbirdError('events_rejected', { count: rejectedCount }));
          if (ack.delivered)
            for (const index of ack.delivered) {
              const entry = wire[index];
              if (entry) unsettled.delete(entry);
            }
          const remaining = batch.filter((entry) => unsettled.has(entry));
          batch.splice(0, batch.length, ...remaining);
          this.completeFlushes();
          if (!batch.length) return;
          if (ack.delivered && batch.length < wire.length) {
            wire = batch.slice();
            progressed = true;
          }
        }
      }
      if (status < 400 || status >= 500) for (const entry of batch) entry.uncertain = true;
      this.stop.signal.throwIfAborted();
      const retry = !redirected && (success || status === 0 || status === 429 || status >= 500);
      if (!retry) {
        for (const entry of batch.splice(0)) this.dropQueued(entry, 'http_error', { status });
        this.report(new LogbirdError(redirected ? 'ingest_redirect' : 'ingest_http_error', { status }));
        this.completeFlushes();
        return;
      }
      if ((!progressed && retries >= this.retries) || attempt >= maxAttempts) {
        if (bodyFailure?.code === 'response_too_large') throw bodyFailure;
        if (success) throw new LogbirdError('ingest_unacknowledged', { status });
        throw new LogbirdError(status ? 'ingest_http_error' : 'ingest_request_failed', { status });
      }
      const seconds = retryAfter ? Number(retryAfter) : Number.NaN;
      const delay = Number.isFinite(seconds) ? seconds * 1000 : Math.min(30_000, 250 * 2 ** retries) * (0.5 + Math.random());
      if (!progressed) retries++;
      await this.timed(Math.max(0, Math.min(60_000, delay, deadline - monotonicNow())), () => undefined);
    }
  }
  private drain(explicit: boolean): Promise<void> {
    if (this.options.enabled === false) return Promise.resolve();
    if (explicit) {
      this.explicit = true;
      this.operationTimer?.ref?.();
    }
    if (this.pending) return this.pending;
    clearTimeout(this.timer);
    this.timer = undefined;
    let start!: () => void;
    const promise = new Promise<void>((resolve, reject) => {
      start = () => void this.drainQueue().then(resolve, reject);
    });
    this.pending = promise;
    start();
    return promise;
  }
  private async drainQueue() {
    try {
      while (this.queue.length) {
        this.stop.signal.throwIfAborted();
        this.completeFlushes();
        const boundary = this.flushWaiters.keys().next().value ?? Number.POSITIVE_INFINITY;
        const batch: QueuedEvent[] = [];
        let bytes = 32;
        while (batch.length < this.batchSize) {
          const next = this.queue[0];
          if (!next || next.sequence > boundary) break;
          if (batch.length && bytes + next.bytes + 1 > 5 * 1024 * 1024) break;
          this.queue.shift();
          batch.push(next);
          bytes += next.bytes + 1;
        }
        this.inFlight = batch;
        try {
          await this.send(batch);
        } catch (error) {
          this.inFlight = [];
          this.queue.unshift(...batch);
          while (this.queue.length + this.preparing.size > this.capacity && !this.closed) {
            const evicted = this.options.dropPolicy === 'newest' ? this.queue.pop() : this.queue.shift();
            if (evicted) this.dropQueued(evicted, 'queue_full');
          }
          throw error;
        }
        this.inFlight = [];
      }
      this.completeFlushes();
    } catch (error) {
      this.completeFlushes({ error });
      throw error;
    } finally {
      this.pending = undefined;
      this.explicit = false;
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
  private completeFlushes(failure?: { error: unknown }) {
    const oldest = this.inFlight[0]?.sequence ?? this.queue[0]?.sequence ?? Number.POSITIVE_INFINITY;
    for (const [target, waiter] of this.flushWaiters) {
      if (target < oldest) waiter.resolve();
      else if (failure) waiter.reject(failure.error);
      else break;
      this.flushWaiters.delete(target);
    }
    if (!this.closed && !this.flushWaiters.size) {
      this.explicit = false;
      this.operationTimer?.unref?.();
    }
  }
  private coalesceFlushTargets() {
    // Dropped or acknowledged targets can become equivalent while an older event is still pending.
    // Share those settlements without extending any caller's coverage to a newer event.
    const outstanding = [...this.inFlight, ...this.queue];
    const merged = new Map<number, FlushWaiter>();
    let index = 0;
    for (const [target, waiter] of this.flushWaiters) {
      for (let entry = outstanding[index]; entry && entry.sequence <= target; entry = outstanding[++index]) {
        // Advance to the last outstanding event covered by this target.
      }
      const covered = outstanding[index - 1]?.sequence;
      if (covered === undefined) waiter.resolve();
      else {
        const shared = merged.get(covered);
        if (shared) waiter.resolve(shared.promise);
        else merged.set(covered, waiter);
      }
    }
    this.flushWaiters = merged;
  }
  flush(): Promise<void> {
    if (this.options.enabled === false || (!this.inFlight.length && !this.queue.length)) return Promise.resolve();
    if (this.flushWaiters.size >= 2 * (this.capacity + this.batchSize)) this.coalesceFlushTargets();
    const target = this.queue.at(-1)?.sequence ?? this.inFlight.at(-1)?.sequence ?? this.lastSequence;
    const existing = this.flushWaiters.get(target);
    if (existing) return existing.promise;
    let resolve!: FlushWaiter['resolve'];
    let reject!: FlushWaiter['reject'];
    const promise = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    this.flushWaiters.set(target, { promise, resolve, reject });
    if (this.pending) {
      this.explicit = true;
      this.operationTimer?.ref?.();
    } else void this.drain(true).catch(() => undefined);
    return promise;
  }
  shutdown(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.closed = true;
    this.stopping = this.finishShutdown();
    return this.stopping;
  }
  private async finishShutdown() {
    this.shutdownDeadline = monotonicNow() + this.shutdownTimeout;
    const abort = () => this.abortShutdown();
    if (this.shutdownTimeout === 0) abort();
    const timer = this.shutdownTimeout > 0 ? setTimeout(abort, this.shutdownTimeout) : undefined;
    try {
      if (this.preparing.size) {
        await Promise.all([this.waitForCaptures(), this.drain(true)]);
      }
      await this.drain(true);
    } catch (error) {
      this.stop.abort(error);
      for (const capture of this.preparing) {
        if (this.options.enabled !== false) this.refuse(capture.identity, 'shutdown');
        capture.finish();
      }
      this.preparing.clear();
      await this.pending?.catch(() => undefined);
      this.completeFlushes({ error });
      for (const entry of this.queue.splice(0)) this.dropQueued(entry, 'shutdown');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  private abortShutdown() {
    this.stop.abort(new LogbirdError('shutdown_timeout'));
  }
  private checkShutdownDeadline() {
    if (this.shutdownDeadline !== undefined && monotonicNow() >= this.shutdownDeadline) this.abortShutdown();
    this.stop.signal.throwIfAborted();
  }
  private async waitForCaptures() {
    const signal = this.stop.signal;
    signal.throwIfAborted();
    let interrupt!: () => void;
    const interrupted = new Promise<never>((_, reject) => {
      interrupt = () => reject(signal.reason);
    });
    signal.addEventListener('abort', interrupt, { once: true });
    try {
      const prepared = Promise.all(Array.from(this.preparing, (entry) => entry.done));
      await Promise.race([prepared, interrupted]);
    } finally {
      signal.removeEventListener('abort', interrupt);
    }
  }
}
