import { type EventInput, type Logbird, uuidv7 } from './index';
export interface AuditCarrier {
  operationId: string;
  requestId?: string;
  traceId?: string;
  parentEventId?: string;
  actor?: EventInput['actor'];
  impersonator?: EventInput['impersonator'];
  tenant?: EventInput['tenant'];
}
export interface Audit {
  (action: string, event?: Partial<EventInput>): string;
  pending(): Promise<void>;
  carrier(partial?: Partial<AuditCarrier>): Promise<AuditCarrier>;
}
type Resolver<C, T> = (context: C) => T | Promise<T>;
export interface CaptureOptions<C> {
  client: Logbird;
  actor?: Resolver<C, EventInput['actor']>;
  impersonator?: Resolver<C, EventInput['impersonator']>;
  tenant?: Resolver<C, EventInput['tenant']>;
  executor?: Resolver<C, EventInput['executor']>;
  ip?: Resolver<C, string | undefined>;
  requestId?: Resolver<C, string | undefined>;
  operationId?: Resolver<C, string | undefined>;
  /**
   * Use an inbound `x-logbird-operation` header as the operation id, so one operation can span services. When it is off,
   * absent or longer than 256 characters, each request gets a new operation id. Defaults to `false`; only `true` turns it on. This sets only the
   * SDK's fallback: an `operationId` resolver that returns a value, or an id set on the event, takes precedence, and
   * what those return is up to your code.
   *
   * Turn it on only for traffic between your own services, behind a trusted ingress that strips or overwrites the header
   * on requests from outside. Any caller can send it, so without that a client can group its requests with someone else's
   * operation in the audit trail.
   */
  useOperationHeader?: boolean;
  /**
   * Use an inbound `x-request-id` header as the request id when present (a longer value than 256 characters is ignored,
   * never cut); otherwise a generated id. Defaults to `false`; only `true` turns it on. This sets only the SDK's fallback: a `requestId` resolver
   * that returns a value, or an id set on the event, takes precedence, and what those return is up to your code.
   *
   * Turn it on only behind a trusted ingress (a gateway or load balancer) that sets this header itself, or strips or
   * overwrites one a client sent. Any caller can send the header, so without that a client chooses the request id its
   * events are recorded and searched under, and can make unrelated requests look like one.
   */
  useRequestIdHeader?: boolean;
  onError?: (error: Error) => void;
}
const pending = new WeakMap<object, Set<Promise<unknown>>>();
function tasks(owner: object) {
  let set = pending.get(owner);
  if (!set) {
    set = new Set();
    pending.set(owner, set);
  }
  return set;
}
async function drain(owner: object): Promise<void> {
  const set = tasks(owner);
  while (set.size) await Promise.allSettled([...set]);
}
export function report(onError: CaptureOptions<unknown>['onError'], error: unknown): void {
  try {
    onError?.(error instanceof Error ? error : new Error(String(error)));
  } catch {
    /* diagnostics are best effort */
  }
}
export async function createAudit<C>(options: CaptureOptions<C>, context: C, request: Request): Promise<Audit> {
  if (typeof window !== 'undefined') throw new Error('Logbird ingest is server-only');
  // A correlation id is used whole or not at all (#206): cutting two long ids to 256 characters could make them one.
  // Longer than 256 means ignored, with the usual generated fallback, as in the ASP.NET Core integration.
  const header = (name: string) => {
    const value = request.headers.get(name);
    return value && value.length <= 256 ? value : undefined;
  };
  const trace = request.headers.get('traceparent')?.match(/^[\da-f]{2}-([\da-f]{32})-([\da-f]{16})-[\da-f]{2}$/);
  return capture(options, context, {
    action: '',
    executor: { type: 'api' },
    context: {
      // Inbound correlation headers are used only when the application opts in (#321): any caller can send them. Only
      // `true` opts in, so a value wired from an environment variable (the string 'false') fails closed.
      operationId: (options.useOperationHeader === true ? header('x-logbird-operation') : undefined) ?? uuidv7(),
      requestId: (options.useRequestIdHeader === true ? header('x-request-id') : undefined) ?? uuidv7(),
      traceId: trace && trace[1] !== '0'.repeat(32) && trace[2] !== '0'.repeat(16) ? trace[1] : undefined,
      userAgent: request.headers.get('user-agent')?.slice(0, 1024) ?? undefined,
    },
  });
}
function capture<C>(options: CaptureOptions<C>, context: C, envelope: EventInput): Audit {
  const local = new Set<Promise<unknown>>();
  function register<T>(promise: Promise<T>): Promise<T> {
    const sets = [local, tasks(options), tasks(options.client)];
    for (const set of sets) set.add(promise);
    const remove = () => {
      for (const set of sets) set.delete(promise);
    };
    void promise.then(remove, remove);
    return promise;
  }
  async function resolve(event: Partial<EventInput>, carrierOnly = false): Promise<EventInput> {
    const merged: EventInput = { ...envelope, ...event, action: event.action ?? '', context: { ...envelope.context, ...event.context } };
    const fields = carrierOnly
      ? (['actor', 'impersonator', 'tenant', 'requestId', 'operationId'] as const)
      : (['actor', 'impersonator', 'tenant', 'executor', 'ip', 'requestId', 'operationId'] as const);
    await Promise.all(
      fields.map(async (field) => {
        const inContext = field === 'ip' || field === 'requestId' || field === 'operationId';
        const overrides = inContext ? event.context : event;
        if (overrides && Object.hasOwn(overrides, field)) return;
        const resolver = options[field];
        if (!resolver) return;
        const target = inContext ? merged.context! : merged;
        try {
          const value = await resolver(context);
          // Missing correlation resolvers retain the request's stable fallback.
          if (value !== undefined || (field !== 'requestId' && field !== 'operationId')) target[field] = value;
        } catch (error) {
          delete target[field];
          report(options.onError, error);
        }
      }),
    );
    return merged;
  }
  const audit = ((action: string, event: Partial<EventInput> = {}) => {
    const id = event.id ?? uuidv7();
    const occurredAt = event.occurredAt ?? new Date().toISOString();
    register(
      resolve({ ...event, action, id, occurredAt })
        .then((resolved) => {
          try {
            options.client.track(resolved);
          } catch (error) {
            report(options.onError, error);
          }
        })
        .catch((error) => report(options.onError, error)),
    );
    return id;
  }) as Audit;
  audit.pending = async () => {
    while (local.size) await Promise.allSettled([...local]);
  };
  audit.carrier = (partial = {}) => {
    const { actor, impersonator, tenant, ...correlation } = partial;
    return register(
      resolve(
        {
          ...('actor' in partial ? { actor } : {}),
          ...('impersonator' in partial ? { impersonator } : {}),
          ...('tenant' in partial ? { tenant } : {}),
          context: correlation,
        },
        true,
      ).then(
        (event) =>
          JSON.parse(
            JSON.stringify({
              operationId: event.context?.operationId ?? envelope.context?.operationId,
              requestId: event.context?.requestId,
              traceId: event.context?.traceId,
              parentEventId: event.context?.parentEventId,
              actor: event.actor,
              impersonator: event.impersonator,
              tenant: event.tenant,
            }),
          ) as AuditCarrier,
      ),
    );
  };
  return audit;
}
export interface JobAuditOptions {
  client: Logbird;
  job: { id?: string | number; name?: string; queueName?: string; attemptsMade?: number };
  carrier?: AuditCarrier;
  executor?: { id?: string; name?: string };
  actor?: EventInput['actor'];
  impersonator?: EventInput['impersonator'];
  tenant?: EventInput['tenant'];
  onError?: (error: Error) => void;
}
export function jobAudit(options: JobAuditOptions): Audit {
  const { job, carrier, executor } = options;
  return capture({ client: options.client, onError: options.onError }, undefined, {
    action: '',
    actor: options.actor ?? carrier?.actor ?? { type: 'system', id: 'scheduler' },
    impersonator: options.impersonator ?? carrier?.impersonator,
    tenant: options.tenant ?? carrier?.tenant,
    executor: {
      type: 'worker',
      id: executor?.id ?? job.queueName ?? 'worker',
      name: executor?.name ?? job.name,
      jobId: job.id === undefined ? undefined : String(job.id),
      attempt: (job.attemptsMade ?? 0) + 1,
    },
    context: {
      operationId: carrier?.operationId ?? uuidv7(),
      requestId: carrier?.requestId,
      traceId: carrier?.traceId,
      parentEventId: carrier?.parentEventId,
    },
  });
}
export async function shutdown(options: Pick<CaptureOptions<unknown>, 'client' | 'onError'>): Promise<void> {
  await drain(options);
  await drain(options.client);
  await options.client.shutdown().catch((error) => report(options.onError, error));
}
