import { loadPublicEnv } from './public-env';

/**
 * OG cards: the renderer (og-cards.ts) imports the site map and the home words, whose text depends on the WEB_* values.
 * Those modules read process.env when they load, so the build's resolved values (.env files included, the same ones the
 * bundle gets) are applied first, and only then is the renderer loaded. seo.ts versions each card from the same words.
 */
for (const [key, value] of Object.entries(loadPublicEnv())) {
  if (value !== undefined) process.env[key] = value;
}
await import('./og-cards');
