import { type EventInput, type Trailmark, uuidv7 } from './index';
export type Audit = (action: string, event?: Partial<EventInput>) => void;
export interface CaptureOptions<C> {
  client: Trailmark;
  actor: (context: C) => EventInput['actor'] | Promise<EventInput['actor']>;
  tenant: (context: C) => EventInput['tenant'] | Promise<EventInput['tenant']>;
  executor?: (context: C) => EventInput['executor'] | Promise<EventInput['executor']>;
  ip?: (context: C) => string | undefined;
  onError?: (error: Error) => void;
}
export function report(onError: CaptureOptions<unknown>['onError'], error: unknown): void {
  try {
    onError?.(error instanceof Error ? error : new Error(String(error)));
  } catch {
    /* diagnostics are best effort */
  }
}
export async function createAudit<C>(options: CaptureOptions<C>, context: C, request: Request): Promise<Audit> {
  if (typeof window !== 'undefined') throw new Error('Trailmark ingest is server-only');
  const header = (name: string) => request.headers.get(name)?.slice(0, 256) || undefined;
  const trace = request.headers.get('traceparent')?.match(/^[\da-f]{2}-([\da-f]{32})-([\da-f]{16})-[\da-f]{2}$/);
  const envelope: EventInput = {
    action: '',
    context: {
      operationId: header('x-trailmark-operation') ?? uuidv7(),
      requestId: header('x-request-id') ?? uuidv7(),
      traceId: trace && trace[1] !== '0'.repeat(32) && trace[2] !== '0'.repeat(16) ? trace[1] : undefined,
      userAgent: request.headers.get('user-agent')?.slice(0, 1024) ?? undefined,
    },
  };
  try {
    if (envelope.context) envelope.context.ip = options.ip?.(context);
    envelope.actor = await options.actor(context);
    envelope.tenant = await options.tenant(context);
    envelope.executor = options.executor ? await options.executor(context) : { type: 'api' };
  } catch (error) {
    report(options.onError, error);
    return () => undefined;
  }
  return (action, event = {}) => {
    try {
      options.client.track({ ...envelope, ...event, action, context: { ...envelope.context, ...event.context } });
    } catch (error) {
      report(options.onError, error);
    }
  };
}
export function shutdown(options: Pick<CaptureOptions<unknown>, 'client' | 'onError'>): Promise<void> {
  return options.client.shutdown().catch((error) => report(options.onError, error));
}
