import type { EventInput } from '@logbird/sdk';
import type { SearchInput } from '@logbird/sdk/read';
import type { H3Event } from 'h3';
export interface LogbirdHooks {
  authorize: (event: H3Event, query: Readonly<Record<string, unknown>>) => false | SearchInput | Promise<false | SearchInput>;
  actor?: (event: H3Event) => EventInput['actor'] | Promise<EventInput['actor']>;
  tenant?: (event: H3Event) => EventInput['tenant'] | Promise<EventInput['tenant']>;
  executor?: (event: H3Event) => EventInput['executor'] | Promise<EventInput['executor']>;
  onError?: (error: Error) => void;
}
