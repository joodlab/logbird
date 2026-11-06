import { fileURLToPath } from 'node:url';
import { defineNuxtConfig } from 'nuxt/config';
export default defineNuxtConfig({
  modules: ['@logbird/nuxt'],
  logbird: {
    hooks: fileURLToPath(new URL('./server/logbird.ts', import.meta.url)),
    endpoint: process.env.LOGBIRD_ENDPOINT ?? 'http://127.0.0.1:4731',
    ingestKey: process.env.LOGBIRD_INGEST_KEY,
    readKey: process.env.LOGBIRD_READ_KEY,
  },
});
