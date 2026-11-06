import { defineEventHandler } from 'h3';
import { useRuntimeConfig } from 'nitropack/runtime';
import hooks from '#logbird-hooks';
import { createReadHandler } from './proxy';
export default defineEventHandler((event) => {
  const config = useRuntimeConfig(event).logbird;
  return createReadHandler({ endpoint: config.endpoint, readKey: config.readKey }, hooks)(event);
});
