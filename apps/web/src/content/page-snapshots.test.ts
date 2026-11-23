import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { elements, type PageElement } from '../lib/page-dom';
import { prerenderPaths } from '../lib/site-map';
import { type PageText, pageFile, pageText, shellFile } from '../test/page-text';
import { quietHrefWarnings, renderPages } from '../test/render-pages';

/**
 * Rendered-page snapshots: every prerendered page and the 404, in each repository × Cloud state, as readable text files
 * under __snapshots__/pages/<state>/. One walk over each page's <body> (src/test/page-text.ts) yields its headings,
 * visible text (one block per line; screen-reader-only, aria-hidden, hidden and noscript text marked; image alt text;
 * <pre> lines kept), links (text and href) and form controls (name, type, value, placeholder, required, checked,
 * selected, disabled, readonly, multiple, aria-label, label and text), every line tagged with its region of <body>.
 *
 * - A page's file (<page>.txt) has its <title> and description, then all those lines in document order, with each
 *   contiguous run of shell lines (the skip link, the site header, the site footer) replaced in place by one
 *   `[shell: … — see _shell.txt]` marker. Text directly under <body>, any other region, and the order of the regions
 *   stay in the page file.
 * - _shell.txt (one per state) has the home page's shell lines. Every page in the state must produce exactly those
 *   lines, and the same shell markup (every tag, attribute and text node of the skip link, header and footer) as the
 *   home page, apart from the router's active-link marks. Those marks (`aria-current="page"`, `data-status="active"`,
 *   the `active` class) must come all three together, and only on the links to the current page and its section.
 *
 * What this pins: the text, headings, links and controls listed above, in order. What it doesn't: styling, classes and
 * layout, images without alt text, and attributes outside that list, except in the shell, whose whole markup is compared.
 * A header or footer wording change is a diff in the four _shell.txt files only.
 *
 * Changing a page on purpose: run
 * `pnpm --filter @logbird/web exec vitest run src/content/page-snapshots.test.ts --update` (`-u` before the path takes
 * the path as its value), review the git diff of the .txt files (only the changes you meant, in every state they apply
 * to) and commit them with the change (CONTRIBUTING.md, "Page snapshots"). When vitest treats the run as CI, the
 * snapshots are only verified: a missing or different one fails, `--update` fails before anything is written, and the
 * last test fails on a snapshot file no page writes any more. Asset cache versions (`?v=`) are masked; nothing depends on
 * the clock or the machine.
 */

const GITHUB = { WEB_GITHUB_URL: 'https://github.com/example-org/logbird' };
const OPEN = { WEB_APP_URL: 'https://app.example.test' };
/** The four states content-modules.test.ts renders; every other key keeps its vitest.config.ts value. */
const STATES = [
  { name: 'private-cloud-closed', env: GITHUB },
  { name: 'private-cloud-open', env: { ...GITHUB, ...OPEN } },
  { name: 'public-cloud-closed', env: { ...GITHUB, WEB_GITHUB_PUBLIC: 'true' } },
  { name: 'public-cloud-open', env: { ...GITHUB, WEB_GITHUB_PUBLIC: 'true', ...OPEN } },
];
const PATHS = [...prerenderPaths, '/404'];
const slug = (path: string) => (path === '/' ? 'home' : path.slice(1).replaceAll('/', '--'));
const SNAPSHOTS = fileURLToPath(new URL('./__snapshots__/pages/', import.meta.url));
/** The shared shell's snapshot in each state's folder; no page slug starts with an underscore. */
const SHELL = '_shell.txt';

const ACTIVE_MARKS = {
  'aria-current="page"': (element: PageElement) => element.attrs['aria-current'] === 'page',
  'data-status="active"': (element: PageElement) => element.attrs['data-status'] === 'active',
  'class "active"': (element: PageElement) => (element.attrs.class ?? '').split(/\s+/).includes('active'),
};

/**
 * The shell's markup, for the equality test. The only way the shell legitimately differs between pages: the router
 * marks the links to the current page (and, for non-exact links, to its section) with all three ACTIVE_MARKS. A link
 * with all three is serialized without them and listed in `active` (once per link, so two links to one page count
 * twice); a link with some but not all is listed in `partial` and stays as it is.
 */
function shellMarkup(page: PageText): { markup: string; active: string[]; partial: string[] } {
  const active: string[] = [];
  const partial: string[] = [];
  const serialize = (node: PageElement | string): string => {
    if (typeof node === 'string') return JSON.stringify(node);
    const attrs = { ...node.attrs };
    if (node.tag === 'a') {
      const marks = Object.entries(ACTIVE_MARKS).filter(([, has]) => has(node));
      if (marks.length === Object.keys(ACTIVE_MARKS).length) {
        active.push(attrs.href ?? '');
        delete attrs['aria-current'];
        delete attrs['data-status'];
        attrs.class = (attrs.class ?? '')
          .split(/\s+/)
          .filter((token) => token !== 'active')
          .join(' ');
      } else if (marks.length) {
        partial.push(`${attrs.href ?? '(no href)'} has only ${marks.map(([name]) => name).join(', ')}`);
      }
    }
    const attributes = Object.entries(attrs)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => ` ${key}=${JSON.stringify(value)}`)
      .join('');
    return `<${node.tag}${attributes}>${node.children.map(serialize).join('')}</${node.tag}>`;
  };
  return { markup: page.shellElements.map(serialize).join('\n'), active, partial };
}

/** Every shell link the router should mark on `path`, once per link: the page itself and its section. None on the 404. */
function expectedActive(path: string, page: PageText): string[] {
  if (path === '/404') return [];
  return page.shellElements
    .flatMap((region) => [region, ...elements(region)])
    .filter((element) => element.tag === 'a')
    .map((element) => element.attrs.href ?? '')
    .filter((href) => href === path || (href !== '/' && path.startsWith(`${href}/`)));
}

const firstDifference = (a: string, b: string) => {
  const [left, right] = [a.split('\n'), b.split('\n')];
  const at = Array.from({ length: Math.max(left.length, right.length) }, (_, index) => index).find((index) => left[index] !== right[index]);
  return at === undefined
    ? undefined
    : `line ${at + 1}: ${JSON.stringify(left[at] ?? '(end)')}, the home page has ${JSON.stringify(right[at] ?? '(end)')}`;
};

/**
 * Whether vitest treats this run as CI: the same std-env module vitest itself imports (resolved from vitest's own
 * location) says so when CI is set to any non-empty value (`0` and `false` included) or a CI provider's variable is set
 * (GITHUB_ACTIONS, for example). As a floor, any CI value other than '', '0' and 'false' counts too.
 */
const fromVitest = createRequire(createRequire(import.meta.url).resolve('vitest/package.json'));
const { isCI: vitestIsCi } = (await import(pathToFileURL(fromVitest.resolve('std-env')).href)) as { isCI: boolean };
const CI_VALUE = process.env.CI;
const IN_CI = vitestIsCi || (CI_VALUE !== undefined && !['', '0', 'false'].includes(CI_VALUE));

/**
 * CI verifies the snapshots and never writes them, like the .NET defaults record (sdks/dotnet/tests/Shared/OptionDefaults.cs).
 * Vitest's CI default is update mode "none"; `--update` (mode "all") or `--update new` there must fail, and before any
 * snapshot is compared, so nothing is written. Vitest sets the snapshot state per test, not in hooks, so every test that
 * writes a snapshot calls this first, and the first test of the file reports why.
 */
function updateRefusal(): string | undefined {
  const update = expect.getState().snapshotState?.snapshotUpdateState;
  if (!IN_CI || update === 'none') return undefined;
  return `vitest --update must not run in CI (CI=${JSON.stringify(CI_VALUE ?? null)}, snapshot update mode "${update}"): the page and shell snapshots are verified there, never written. Update them locally and commit the files.`;
}
const refuseUpdateInCi = () => {
  if (updateRefusal()) throw new Error('Snapshot update refused in CI: see "snapshot updates never run in CI".');
};

it('snapshot updates never run in CI', () => {
  const refusal = updateRefusal();
  if (refusal) throw new Error(refusal);
});

describe.each(STATES)('rendered pages, $name', ({ name, env }) => {
  const rendered = new Map<string, PageText>();
  beforeAll(async () => {
    quietHrefWarnings();
    // The page list comes from this state's own module graph, so a page that only one state publishes can't be missed.
    await renderPages([], env);
    const stateMap = await import('../lib/site-map');
    expect([...stateMap.prerenderPaths, '/404'], 'the page list differs in this state; derive PATHS per state').toEqual(PATHS);
    for (const { path, html } of await renderPages(PATHS, env)) rendered.set(path, pageText(html));
  }, 180_000);
  afterAll(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  const page = (path: string) => {
    const text = rendered.get(path);
    if (!text) throw new Error(`${path} did not render`);
    return text;
  };

  // The home page's shell stands for every page; the next test holds each page to it.
  it('shell (skip link, header, footer)', async () => {
    refuseUpdateInCi();
    await expect(shellFile(page('/'))).toMatchFileSnapshot(`./__snapshots__/pages/${name}/${SHELL}`);
  });

  it('every page renders exactly the snapshotted shell', () => {
    const home = page('/');
    const lines = shellFile(home);
    const { markup } = shellMarkup(home);
    const drift: string[] = [];
    for (const path of PATHS) {
      const own = page(path);
      const textDiff = firstDifference(shellFile(own), lines);
      if (textDiff) drift.push(`${path}: shell lines differ at ${textDiff}`);
      const marked = shellMarkup(own);
      if (marked.markup !== markup) {
        // The markup is one long line per region: show where it starts to differ, not the whole region.
        let at = 0;
        while (marked.markup[at] === markup[at]) at++;
        const around = (text: string) => JSON.stringify(text.slice(Math.max(0, at - 40), at + 80));
        drift.push(`${path}: shell markup differs (beyond the active-link marks) at ${around(marked.markup)}, the home page has ${around(markup)}`);
      }
      for (const link of marked.partial) drift.push(`${path}: a partly marked active link: ${link}`);
      const want = expectedActive(path, own).sort();
      const got = [...marked.active].sort();
      if (JSON.stringify(got) !== JSON.stringify(want)) drift.push(`${path}: active links ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
    }
    expect(drift, 'pages whose shell differs from the shared one').toEqual([]);
  });

  it.each(PATHS)('%s', async (path) => {
    refuseUpdateInCi();
    await expect(pageFile(page(path))).toMatchFileSnapshot(`./__snapshots__/pages/${name}/${slug(path)}.txt`);
  });
});

// Vitest writes new file snapshots after the run and never reports one that no test reads, so this catches the stale
// ones (a missing one fails its own test in CI).
it('every snapshot file belongs to a rendered page and state', () => {
  const expected = new Set(STATES.flatMap(({ name }) => [SHELL, ...PATHS.map((path) => `${slug(path)}.txt`)].map((file) => `${name}/${file}`)));
  const onDisk = (existsSync(SNAPSHOTS) ? readdirSync(SNAPSHOTS, { recursive: true, encoding: 'utf8' }) : [])
    .map((file) => file.replaceAll('\\', '/'))
    .filter((file) => file.endsWith('.txt'));
  expect(
    onDisk.filter((file) => !expected.has(file)),
    'snapshot files no page writes any more: delete them',
  ).toEqual([]);
});
