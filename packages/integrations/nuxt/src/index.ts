export type { AuditedH3Event } from './runtime/capture';

export type { TrailmarkHooks } from './runtime/hooks';

import { addImports, addServerHandler, addServerPlugin, createResolver, defineNuxtModule } from '@nuxt/kit';
export interface ModuleOptions {
  endpoint?: string;
  ingestKey?: string;
  readKey?: string;
  /** Absolute path to a server-only module exporting authorize and optional capture resolvers. */
  hooks?: string;
}
export default defineNuxtModule<ModuleOptions>({
  meta: { name: '@trailmark/nuxt', configKey: 'trailmark' },
  defaults: { endpoint: 'http://127.0.0.1:4731', ingestKey: '', readKey: '' },
  setup(options, nuxt) {
    const resolver = createResolver(import.meta.url);
    nuxt.options.runtimeConfig.trailmark = {
      endpoint: options.endpoint,
      ingestKey: options.ingestKey,
      readKey: options.readKey,
      ...(nuxt.options.runtimeConfig.trailmark as object),
    };
    nuxt.options.nitro.alias ??= {};
    nuxt.options.nitro.alias['#trailmark-hooks'] = options.hooks ?? resolver.resolve('./runtime/deny');
    addServerPlugin(resolver.resolve('./runtime/plugin'));
    addServerHandler({ route: '/api/_trailmark/events', method: 'get', handler: resolver.resolve('./runtime/events') });
    addImports({ name: 'useAuditTrail', from: resolver.resolve('./runtime/composable') });
  },
});
