import { Logbird } from '@logbird/sdk';
import { report, shutdown } from '@logbird/sdk/integration';
import { defineNitroPlugin, useRuntimeConfig } from 'nitropack/runtime';
import hooks from '#logbird-hooks';
import { attachAudit } from './capture';
export default defineNitroPlugin((nitro) => {
  const config = useRuntimeConfig().logbird;
  const client = new Logbird({ endpoint: config.endpoint, apiKey: config.ingestKey, onError: hooks.onError });
  nitro.hooks.hook('request', (event) => attachAudit(event, client, hooks));
  nitro.hooks.hook('afterResponse', (event) => {
    event.waitUntil((event.context.audit?.pending() ?? Promise.resolve()).then(() => client.flush()).catch((error) => report(hooks.onError, error)));
  });
  nitro.hooks.hook('close', () => shutdown({ client, onError: hooks.onError }));
});
