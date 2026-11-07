import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { nitro } from 'nitro/vite';
import { defineConfig, loadEnv } from 'vite';
import { llmsTxt, robotsTxt, sitemapXml } from './src/lib/discovery';
import { prerenderPaths } from './src/lib/site-map';
export const securityHeaders = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};
export default defineConfig(({ mode }) => {
  const loaded = { ...loadEnv(mode, '../..', ''), ...loadEnv(mode, process.cwd(), ''), ...process.env };
  const publicEnv = Object.fromEntries(['SITE_URL', 'APP_URL', 'GITHUB_URL', 'GITHUB_PUBLIC'].map((key) => [key, loaded[key]]));
  const preset = process.env.NITRO_PRESET ?? 'node-server';
  return {
    resolve: { tsconfigPaths: true },
    define: { __SITE_ENV__: JSON.stringify(publicEnv), 'import.meta.env.NITRO_PRESET': JSON.stringify(preset) },
    server: { port: 4620, strictPort: true },
    preview: { port: 4620, strictPort: true },
    build: { manifest: true },
    plugins: [
      tailwindcss(),
      nitro({
        preset,
        handlers: [{ route: '/api/waitlist', handler: './server/waitlist.ts' }],
        routeRules: {
          '/**': { headers: securityHeaders },
          '/assets/**': { headers: { 'Cache-Control': 'public, max-age=31536000, immutable' } },
          '/media/**': { headers: { 'Cache-Control': 'public, max-age=31536000, immutable' } },
        },
        // Pre-compressed .br/.gz copies, served by the Node preview; Cloudflare compresses on its own.
        compressPublicAssets: { gzip: true, brotli: true },
        cloudflare: { deployConfig: false },
      }),
      tanstackStart({
        router: { codeSplittingOptions: { defaultBehavior: [['component']] } },
        sitemap: { enabled: false },
        pages: [...prerenderPaths.map((path) => ({ path })), { path: '/404', prerender: { outputPath: '/404.html', crawlLinks: false } }],
        prerender: {
          enabled: !(preset === 'cloudflare-module' && process.env.LOGBIRD_WEB_STATIC_READY === '1'),
          crawlLinks: true,
          failOnError: true,
          concurrency: 1,
          autoStaticPathsDiscovery: false,
        },
      }),
      viteReact(),
      {
        name: 'logbird-preview-port',
        enforce: 'post',
        // Start passes port 0 to Vite during prerender. Keep every preview on our assigned port.
        config: () => ({ preview: { port: 4620, strictPort: true } }),
      },
      {
        name: 'logbird-discovery',
        apply: 'build',
        generateBundle() {
          if (this.environment.name !== 'client') {
            return;
          }
          for (const [fileName, source] of Object.entries({ 'sitemap.xml': sitemapXml(), 'robots.txt': robotsTxt(), 'llms.txt': llmsTxt() })) {
            this.emitFile({ type: 'asset', fileName, source });
          }
          this.emitFile({
            type: 'asset',
            fileName: '_headers',
            source: `/*\n${Object.entries(securityHeaders)
              .map(([key, value]) => `  ${key}: ${value}`)
              .join(
                '\n',
              )}\n/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n/media/*\n  Cache-Control: public, max-age=31536000, immutable\n`,
          });
        },
      },
    ],
  };
});
