/**
 * Sends one event with every kind of party through the TypeScript SDK's redact(), with a pattern matching every party
 * key, to a live Logbird server, and prints its id, so the .NET live test
 * Both_sdks_store_the_same_parties_when_a_pattern_matches_every_party_key can read it back and compare it with the
 * event the .NET SDK sends. Run from the repository root:
 *   LOGBIRD_IT_ENDPOINT=... LOGBIRD_IT_INGEST_KEY=... pnpm exec tsx sdks/dotnet/tests/cross-sdk/send-redacted-event.ts
 */
import { Logbird, redact, uuidv7 } from '../../../../packages/sdk/src/index';

const endpoint = process.env.LOGBIRD_IT_ENDPOINT;
const apiKey = process.env.LOGBIRD_IT_INGEST_KEY;
if (!endpoint || !apiKey) throw new Error('Set LOGBIRD_IT_ENDPOINT and LOGBIRD_IT_INGEST_KEY');
const id = uuidv7();
let failure: Error | undefined;
const client = new Logbird({
  endpoint,
  apiKey,
  beforeSend: redact({ keys: /actor|impersonator|executor|tenant|targets/ }),
  onError: (error) => {
    failure = error;
  },
  onDrop: () => {
    failure ??= new Error('dropped');
  },
});
// The same parties as RedactionLiveTests sends from .NET (fictional values only).
client.track({
  id,
  action: 'redaction.parity_checked',
  actor: { type: 'user', id: 'user_redaction_1', name: 'Fictional User', email: 'fictional.user@example.invalid' },
  impersonator: { id: 'support_redaction_1', name: 'Fictional Support' },
  executor: { type: 'worker', id: 'redaction-worker', name: 'Redaction worker', jobId: 'job_redaction_1', attempt: 3 },
  tenant: { id: 'acct_redaction_1', name: 'Fictional Co' },
  targets: [{ type: 'invoice', id: 'inv_redaction_1', name: 'INV-REDACT-1' }],
});
await client.shutdown();
if (failure) throw failure;
console.log(`LOGBIRD_IT_TS_REDACTED_ID=${id}`);
