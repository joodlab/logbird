import { Logbird } from '@logbird/sdk';
export const endpoint = process.env.LOGBIRD_ENDPOINT ?? 'http://127.0.0.1:4731';
export const client = new Logbird({
  endpoint,
  apiKey: process.env.LOGBIRD_INGEST_KEY ?? '',
  onError: console.error,
});
export const options = {
  client,
  actor: () => ({ type: 'user', id: 'demo-user' }),
  executor: () => ({ type: 'api', id: 'demo-api', name: 'Demo API' }),
  tenant: () => ({ id: 'demo-tenant' }),
  onError: console.error,
};
