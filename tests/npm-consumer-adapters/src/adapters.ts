// Type-checks the packed Vue, Nuxt and TanStack Start adapters as an application would use them. Not run: these
// packages are not published yet (phase 1 is @logbird/sdk and @logbird/hono); this keeps their published types honest.
import type { AuditedH3Event, LogbirdHooks, ModuleOptions } from '@logbird/nuxt';
import logbirdNuxt from '@logbird/nuxt';
import { Logbird } from '@logbird/sdk';
import { auditForRequest, type LogbirdFunctionMiddleware, type LogbirdRequestMiddleware, logbird } from '@logbird/tanstack-start';
import { type AuditFetcher, type AuditTrailOptions, useAuditTrail } from '@logbird/vue';

const client = new Logbird({ endpoint: 'https://audit.example.invalid', apiKey: 'lb_ingest_fictional' });

// TanStack Start: the two middlewares keep their named types.
const capture = logbird({ client, actor: () => ({ type: 'user', id: 'u1' }) });
const requestMiddleware: LogbirdRequestMiddleware = capture.requestMiddleware;
const functionMiddleware: LogbirdFunctionMiddleware = capture.functionMiddleware;
export const tanstack = { requestMiddleware, functionMiddleware, shutdown: capture.shutdown, auditForRequest };

// Vue: the composable over an application-provided fetcher.
const fetcher: AuditFetcher = async () => ({ data: [], nextCursor: null, total: 0, tookMs: 0 });
const options: AuditTrailOptions = { target: { type: 'invoice', id: 'inv_1' }, fetcher };
export const vue = () => useAuditTrail(options);

// Nuxt: the module and its option and hook types.
const moduleOptions: ModuleOptions = { endpoint: 'https://audit.example.invalid', hooks: '/srv/logbird-hooks.ts' };
const hooks: LogbirdHooks = { authorize: () => false };
export const nuxt = { module: logbirdNuxt, moduleOptions, hooks, audited: undefined as AuditedH3Event | undefined };
