import { fileURLToPath } from 'node:url';
import { defineNuxtConfig } from 'nuxt/config';
export default defineNuxtConfig({
  modules: ['@trailmark/nuxt'],
  trailmark: {
    hooks: fileURLToPath(new URL('./server/trailmark.ts', import.meta.url)),
    endpoint: process.env.TRAILMARK_ENDPOINT ?? 'http://127.0.0.1:4731',
    ingestKey: process.env.TRAILMARK_INGEST_KEY,
    readKey: process.env.TRAILMARK_READ_KEY,
  },
});
