import { createClient } from '@hey-api/openapi-ts';

for (const [input, output] of [
  ['./openapi/public.json', 'experiments/hey-api/public'],
  ['./openapi/openapi.json', 'experiments/hey-api/console'],
])
  await createClient({ input, output, plugins: ['@hey-api/typescript', '@hey-api/sdk', '@hey-api/client-fetch'] });
