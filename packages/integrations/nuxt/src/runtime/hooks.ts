import type { EventInput } from '@logbird/sdk';
import type { SearchInput } from '@logbird/sdk/read';
import type { H3Event } from 'h3';
export interface LogbirdHooks {
  authorize: (event: H3Event, query: Readonly<Record<string, unknown>>) => false | SearchInput | Promise<false | SearchInput>;
  actor?: (event: H3Event) => EventInput['actor'] | Promise<EventInput['actor']>;
  tenant?: (event: H3Event) => EventInput['tenant'] | Promise<EventInput['tenant']>;
  executor?: (event: H3Event) => EventInput['executor'] | Promise<EventInput['executor']>;
  /** Use an inbound `x-logbird-operation` header as the operation id. Off by default; see `CaptureOptions.useOperationHeader`. */
  useOperationHeader?: boolean;
  /** Use an inbound `x-request-id` header as the request id. Off by default; see `CaptureOptions.useRequestIdHeader`. */
  useRequestIdHeader?: boolean;
  onError?: (error: Error) => void;
}
