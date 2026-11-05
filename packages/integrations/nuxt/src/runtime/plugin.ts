import { Trailmark } from '@trailmark/sdk';
import { report, shutdown } from '@trailmark/sdk/integration';
import { defineNitroPlugin, useRuntimeConfig } from 'nitropack/runtime';
import hooks from '#trailmark-hooks';
import { attachAudit } from './capture';
export default defineNitroPlugin((nitro) => {
  const config = useRuntimeConfig().trailmark;
  const client = new Trailmark({ endpoint: config.endpoint, apiKey: config.ingestKey, onError: hooks.onError });
  nitro.hooks.hook('request', (event) => attachAudit(event, client, hooks));
  nitro.hooks.hook('afterResponse', (event) => {
    event.waitUntil(client.flush().catch((error) => report(hooks.onError, error)));
  });
  nitro.hooks.hook('close', () => shutdown({ client, onError: hooks.onError }));
});
