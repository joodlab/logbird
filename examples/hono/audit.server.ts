import { Logbird, type LogbirdError } from '@logbird/sdk';

function reportError({ code, status, count }: LogbirdError) {
  console.error('Logbird audit', { code, status, count });
}

export const endpoint = process.env.LOGBIRD_ENDPOINT ?? 'http://127.0.0.1:4731';
export const client = new Logbird({
  endpoint,
  apiKey: process.env.LOGBIRD_INGEST_KEY ?? '',
  onError: reportError,
});
export const options = {
  client,
  actor: () => ({ type: 'user', id: 'demo-user' }),
  executor: () => ({ type: 'api', id: 'demo-api', name: 'Demo API' }),
  tenant: () => ({ id: 'demo-tenant' }),
  onError: reportError,
};
