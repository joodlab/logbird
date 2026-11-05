import { defineEventHandler } from 'h3';
export default defineEventHandler((event) => {
  event.context.audit('nuxt.record.updated', { targets: [{ type: 'record', id: 'demo-record' }] });
  return { ok: true };
});
