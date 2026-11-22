/**
 * Sends one minimal event through the TypeScript SDK to a live Logbird server and prints its id and timestamp, so
 * the .NET live test Replaying_a_typescript_event_from_csharp_is_an_exact_retry can resend it. Run from the repository root:
 *   LOGBIRD_IT_ENDPOINT=... LOGBIRD_IT_INGEST_KEY=... pnpm exec tsx sdks/dotnet/tests/cross-sdk/send-typescript-event.ts
 */
import { Logbird, uuidv7 } from '../../../../packages/sdk/src/index';

const endpoint = process.env.LOGBIRD_IT_ENDPOINT;
const apiKey = process.env.LOGBIRD_IT_INGEST_KEY;
if (!endpoint || !apiKey) throw new Error('Set LOGBIRD_IT_ENDPOINT and LOGBIRD_IT_INGEST_KEY');
const id = uuidv7();
const occurredAt = new Date().toISOString();
let failure: Error | undefined;
const client = new Logbird({
  endpoint,
  apiKey,
  onError: (error) => {
    failure = error;
  },
  onDrop: () => {
    failure ??= new Error('dropped');
  },
});
client.track({ id, action: 'cross.sdk.replayed', occurredAt });
await client.shutdown();
if (failure) throw failure;
console.log(`LOGBIRD_IT_TS_EVENT_ID=${id}`);
console.log(`LOGBIRD_IT_TS_EVENT_AT=${occurredAt}`);
