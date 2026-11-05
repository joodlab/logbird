import { Trailmark } from '@trailmark/sdk';
export const client = new Trailmark({
  endpoint: process.env.TRAILMARK_ENDPOINT ?? 'http://127.0.0.1:4731',
  apiKey: process.env.TRAILMARK_INGEST_KEY ?? '',
  onError: console.error,
});
export const options = { client, actor: () => ({ type: 'user', id: 'demo-user' }), tenant: () => ({ id: 'demo-tenant' }), onError: console.error };
