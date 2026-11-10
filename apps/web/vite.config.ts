import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { nitro } from 'nitro/vite';
import { defineConfig } from 'vite';
import { loadPublicEnv } from './scripts/public-env';
import { loadReleases } from './scripts/releases';
import { localPublicUrls, siteConfigFrom } from './src/env';
import { llmsTxt, robotsTxt, sitemapXml } from './src/lib/discovery';
import { ASSET_CACHE, DEV_CONTENT_SECURITY_POLICY, MEDIA_CACHE, securityHeaders } from './src/lib/security-headers';
import { prerenderPaths } from './src/lib/site-map';

export default defineConfig(async ({ mode, command }) => {
  // Only WEB_* variables reach the site, so the console's APP_URL (localhost in the shared .env) never leaks in.
  // Resolved once and passed to the bundle and the discovery files alike.
  const publicEnv = loadPublicEnv(mode);
  const config = siteConfigFrom(publicEnv);
  const preset = process.env.NITRO_PRESET ?? 'node-server';
  if (preset === 'cloudflare-module') {
    const local = localPublicUrls(publicEnv);
    if (local.length) {
      throw new Error(`A public (Cloudflare) build can't point at a developer machine: ${local.join(', ')}.`);
    }
  }
  // Builds serve every page with its own hashed script policy (scripts/csp.ts runs after the build). `vite dev` renders
  // on demand and injects HMR scripts, so only the dev server keeps 'unsafe-inline' for scripts.
  const headers = command === 'build' ? securityHeaders : { ...securityHeaders, 'Content-Security-Policy': DEV_CONTENT_SECURITY_POLICY };
  return {
    // One React for the site and @logbird/ui (which resolves React from the workspace root).
    resolve: { tsconfigPaths: true, dedupe: ['react', 'react-dom'] },
    define: {
      __SITE_ENV__: JSON.stringify(publicEnv),
      // Published releases for /changelog and the self-host quickstart, resolved once per build (scripts/releases.ts).
      __RELEASES__: JSON.stringify(await loadReleases({ githubUrl: config.GITHUB_URL, githubPublic: config.GITHUB_PUBLIC })),
      'import.meta.env.NITRO_PRESET': JSON.stringify(preset),
    },
    server: { port: 4620, strictPort: true },
    // 127.0.0.1, not localhost: in Linux containers localhost may resolve to ::1 while the prerenderer fetches 127.0.0.1.
    preview: { host: '127.0.0.1', port: 4620, strictPort: true },
    build: { manifest: 'site-assets/manifest.json', assetsDir: 'site-assets' },
    plugins: [
      tailwindcss(),
      nitro({
        preset,
        // Deletes form submissions older than the privacy policy's retention period (Node server only).
        plugins: ['./server/plugins/form-retention.ts'],
        handlers: [
          { route: '/site-api/waitlist', handler: './server/waitlist.ts' },
          // Any other /site-api/* path: a JSON 404, never an on-demand page.
          { route: '/site-api/**', handler: './server/api-not-found.ts' },
          // Pages are static: other methods than GET/HEAD outside /site-api/ get 405, on every preset.
          ...(command === 'build' ? [{ route: '/**', middleware: true, handler: './server/method-guard.ts' }] : []),
          // The Node server serves the prerendered pages with their hashed CSP (Cloudflare does this with _headers).
          ...(command === 'build' && preset === 'node-server' ? [{ route: '/**', middleware: true, handler: './server/static-pages.ts' }] : []),
        ],
        routeRules: {
          '/**': { headers },
          '/site-assets/**': { headers: { 'Cache-Control': ASSET_CACHE } },
          // Media keeps stable names (a replaced capture reuses its URL), so it is never immutable.
          '/media/**': { headers: { 'Cache-Control': MEDIA_CACHE } },
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
        config: () => ({ preview: { host: '127.0.0.1', port: 4620, strictPort: true } }),
      },
      {
        name: 'logbird-discovery',
        apply: 'build',
        generateBundle() {
          if (this.environment.name !== 'client') {
            return;
          }
          for (const [fileName, source] of Object.entries({
            'sitemap.xml': sitemapXml(config),
            'robots.txt': robotsTxt(config),
            'llms.txt': llmsTxt(config),
          })) {
            this.emitFile({ type: 'asset', fileName, source });
          }
          // `_headers` is written after prerendering by scripts/csp.ts, which needs the final HTML to hash.
        },
      },
    ],
  };
});
