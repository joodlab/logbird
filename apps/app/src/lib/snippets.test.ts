import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { highlight } from '@logbird/ui/lib/highlight';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { curlSnippet, dotnetSnippet, fetchSnippet, SDK_PUBLISHED, sdkInstall, sdkInstallComment, sdkSnippet } from './snippets';

describe('the C# (.NET) first-event snippet', () => {
  it('posts the same event as curl with plain HttpClient, using the session key', () => {
    const code = dotnetSnippet('lb_ingest_example');
    expect(code).toContain('new("Bearer", "lb_ingest_example")');
    expect(code).toContain('/v1/events');
    for (const field of ['action = "hotel.policy.updated"', 'tenant = new { id = "biz_7"', 'field = "cancellationHours", before = 24, after = 48'])
      expect(code).toContain(field);
    // The same event as the curl tab.
    expect(curlSnippet('k')).toContain('"cancellationHours", "before": 24, "after": 48');
  });
  it('reads the key from the environment when the session has none', () => {
    expect(dotnetSnippet()).toContain('Environment.GetEnvironmentVariable("LOGBIRD_INGEST_KEY")');
  });
  it('names no package until the .NET package is published', () => {
    const code = dotnetSnippet('k');
    expect(code).not.toMatch(/dotnet add|PackageReference|using Logbird/);
  });
  it('is highlighted as C#', () => {
    const tokens = highlight('var response = await http.PostAsJsonAsync("x", new { action = "a" });', 'csharp');
    expect(tokens.filter((t) => t.type === 'keyword').map((t) => t.text)).toEqual(['var', 'await', 'new']);
    // No context-free way to tell `action = …` (a member) from `response = …` (a variable): neither is coloured as a key.
    expect(tokens.some((t) => t.type === 'key')).toBe(false);
    expect(tokens.filter((t) => t.type === 'string').map((t) => t.text)).toEqual(['"x"', '"a"']);
  });
});

// The first commands a customer runs: the fetch and SDK snippets are executed as rendered, against a stand-in for
// /v1/events, so a snippet that stops sending the event or stops reporting a rejection fails here. (curl and C# are run
// by hand against a real server; see the PR.)
describe('the first-event snippets, executed', () => {
  const stored = { accepted: 1, ids: ['evt_1'], rejected: [], warnings: [] };
  const refused = {
    accepted: 0,
    ids: [],
    rejected: [{ index: 0, reason: 'invalid_event: action must be a string', code: 'invalid_event' }],
    warnings: [],
  };
  const standIn = (body: unknown, status = 202) =>
    vi.fn(
      async (_url: string, _init: RequestInit) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
    );
  const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...args: string[]) => (...a: unknown[]) => Promise<void>;
  afterEach(() => vi.unstubAllGlobals());

  it('fetch: sends the event with its own id and changes, and reports a 202 that rejected it', async () => {
    // The snippet runs as a module of its own (it may import node:crypto), with no global Web Crypto, as on Node 18.
    const run = async (fetch: ReturnType<typeof standIn>, log = vi.fn()) => {
      const file = join(mkdtempSync(join(tmpdir(), 'logbird-snippet-')), 'first-event.mjs');
      writeFileSync(file, fetchSnippet('lb_ingest_test'));
      const crypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
      vi.stubGlobal('fetch', fetch);
      const logs = vi.spyOn(console, 'log').mockImplementation(log);
      delete (globalThis as { crypto?: unknown }).crypto;
      try {
        await import(/* @vite-ignore */ pathToFileURL(file).href);
      } finally {
        if (crypto) Object.defineProperty(globalThis, 'crypto', crypto);
        logs.mockRestore();
      }
    };
    const ok = standIn(stored);
    const log = vi.fn();
    await run(ok, log);
    const [url, init] = ok.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/events$/);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer lb_ingest_test');
    const sent = JSON.parse(String(init.body));
    expect(typeof sent.id).toBe('string');
    expect(sent.changes).toEqual([{ field: 'cancellationHours', before: 24, after: 48 }]);
    expect(log).toHaveBeenCalledWith('Stored', ['evt_1']);
    await expect(run(standIn(refused))).rejects.toThrow('Logbird rejected the event: invalid_event: action must be a string');
    await expect(run(standIn({ error: { code: 'unauthorized' } }, 401))).rejects.toThrow('Logbird answered 401');
  });

  it('SDK: delivers on shutdown, reports a rejected event through onError, and never throws from shutdown', async () => {
    const { Logbird } = await import('../../../../packages/sdk/src/index');
    const body = sdkSnippet('lb_ingest_test').replace(/^import .*$/m, '');
    const run = async (fetch: ReturnType<typeof standIn>) => {
      vi.stubGlobal('fetch', fetch);
      const error = vi.fn();
      await new AsyncFunction('Logbird', 'console', body)(Logbird, { error, log: vi.fn() });
      return error;
    };
    const ok = vi.fn(async (_url: string, init: RequestInit) =>
      Response.json({ ...stored, ids: [JSON.parse(String(init.body)).events[0].id] }, { status: 202 }),
    );
    expect(await run(ok)).not.toHaveBeenCalled();
    const sent = JSON.parse(String((ok.mock.calls[0] as [string, RequestInit])[1].body));
    expect(sent.events[0]).toMatchObject({ action: 'hotel.policy.updated', changes: [{ field: 'cancellationHours', before: 24, after: 48 }] });
    expect(typeof sent.events[0].id).toBe('string');
    const errors = await run(standIn(refused));
    expect(errors).toHaveBeenCalledWith('[logbird]', '1 events rejected by Logbird');
  });

  it('shows the install that works today, and says the key belongs in the environment', () => {
    // Both publication states, so flipping SDK_PUBLISHED needs no test change; the panel shows the current one.
    expect(sdkInstall(false)).toContain('https://github.com/joodlab/logbird/releases/download/v$version');
    expect(sdkInstall(false)).toContain('pnpm add "$base/logbird-sdk-$version.tgz"');
    expect(sdkInstall(false)).toContain('pnpm dlx tsx first-event.mts');
    expect(sdkInstall(false)).not.toMatch(/^pnpm add @logbird\/sdk$/m);
    expect(sdkInstall(true)).toBe('pnpm add @logbird/sdk');
    expect(sdkInstallComment()).toBe(
      sdkInstall(SDK_PUBLISHED)
        .split('\n')
        .map((line) => `// ${line}`)
        .join('\n'),
    );
    for (const code of [sdkSnippet('k'), fetchSnippet('k'), dotnetSnippet('k')]) expect(code).toMatch(/never commit a key/);
    // Raw HTTP sends its own id; the curl comment shows the 202 body and the field to check.
    expect(curlSnippet('k')).toMatch(/"id": "evt_hotel_123_policy_1"/);
    expect(curlSnippet('k')).toMatch(/"rejected":\[\]/);
    expect(dotnetSnippet('k')).toMatch(/var id = Guid\.NewGuid\(\)\.ToString\(\);/);
    expect(dotnetSnippet('k')).toMatch(/result!\.rejected\.Length > 0/);
  });

  it('SDK: a shutdown that rejects is caught and reported, never thrown', async () => {
    const failure = new Error('server unreachable');
    class Unreachable {
      track() {
        // Accepted and queued; only the delivery on shutdown fails here.
      }
      shutdown() {
        return Promise.reject(failure);
      }
    }
    const error = vi.fn();
    const body = sdkSnippet('lb_ingest_test').replace(/^import .*$/m, '');
    await expect(new AsyncFunction('Logbird', 'console', body)(Unreachable, { error, log: vi.fn() })).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith('[logbird] undelivered', failure);
  });

  it('fetch: bundles for a browser or edge worker, where node:crypto does not exist', async () => {
    const { build } = await import('esbuild');
    const worker = `export default { async fetch() {\n${fetchSnippet('lb_ingest_test')}\nreturn new Response('ok'); } };`;
    const result = await build({
      stdin: { contents: worker, loader: 'js' },
      bundle: true,
      platform: 'browser',
      format: 'esm',
      write: false,
      logLevel: 'silent',
    });
    expect(result.errors).toEqual([]);
  });

  it('renders every tab without a missing piece', () => {
    for (const code of [
      curlSnippet('k'),
      curlSnippet(),
      fetchSnippet('k'),
      fetchSnippet(),
      sdkSnippet('k'),
      sdkSnippet(),
      dotnetSnippet('k'),
      dotnetSnippet(),
      sdkInstallComment(),
    ])
      expect(code).not.toMatch(/undefined|\bnull\b|\[object/);
  });
});
