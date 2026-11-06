// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Codemod matches literal source and Compose expressions.
/** Rename tracked UTF-8 source and prose. Historical captures and brand rationale stay verbatim.
 * Refresh: rebase -> codemod -> pnpm install -> pnpm fix -> pnpm openapi:export -> --check.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

const check = process.argv.includes('--check');
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const excluded = (file) =>
  file === 'docs/brand.md' ||
  file === 'scripts/rename-to-logbird.mjs' ||
  file === 'scripts/migrate-namespace-to-logbird.ts' ||
  /^docs\/.*evidence.*\.jsonl?$/i.test(file) ||
  /^docs\/(qa|verification)\//.test(file);
const bird = 'M6.5 20.5c0-5.8 4.4-10 10-10h1.6a4.6 4.6 0 0 1 4.4 3.2l3 1-3 1c-.9 2.8-3.5 4.8-6.6 4.8H6.5z';
const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><style>.t{fill:#171717}.f{fill:#fafafa}.s{stroke:#fafafa}@media (prefers-color-scheme:dark){.t{fill:#ededed}.f{fill:#0b0b0c}.s{stroke:#0b0b0c}}</style><rect class="t" width="32" height="32" rx="8"/><path class="f" d="${bird}"/><circle class="t" cx="19.6" cy="13.9" r="1.35"/><path class="s" d="M6.5 25h11" fill="none" stroke-width="2.4" stroke-linecap="round"/><path d="M21 25h4.5" stroke="#818cf8" stroke-width="2.4" stroke-linecap="round"/></svg>`;

function rename(file, input) {
  let text = input.replace(/\n## Legacy identifiers[\s\S]*$/, '');
  // Remove old env aliases before the literal replacement can produce duplicate reads.
  text = text.replace(/(process\.env|env|rootEnv)\.LOGBIRD_(\w+) \|\| (?:process\.env|env|rootEnv)\.TRAILMARK_\2/g, '$1.LOGBIRD_$2');
  text = text.replace(/\$\{LOGBIRD_(\w+):-\$\{TRAILMARK_\1([^}]*)\}\}/g, '${LOGBIRD_$1$2}');
  text = text.replaceAll('Trailmark', 'Logbird').replaceAll('TRAILMARK', 'LOGBIRD').replaceAll('trailmark', 'logbird');
  text = text.replaceAll('tm_ingest_', 'lb_ingest_').replaceAll('tm_read_', 'lb_read_');
  if (file === 'apps/server/src/keys.ts') text = text.replaceAll('`tm_${kind}_', '`lb_${kind}_');
  text = text.replace("[SAMPLE_DATA_SOURCE, 'logbird-sample']", '[SAMPLE_DATA_SOURCE]');
  text = text.replace(
    'preserve existing data, sessions and environment fallbacks.',
    'include an explicit namespace migration for existing installations.',
  );
  if (file === 'packages/auth/src/server.ts' && !text.includes('cookiePrefix:'))
    text = text.replace('advanced: {', "advanced: { cookiePrefix: 'logbird',");
  if (file === 'apps/server/src/middlewares/require-api-key.ts') {
    text = text.replace('tm_(?:ingest|read)', '(?:lb|tm)_(?:ingest|read)');
    text = text.replace('!secret?.startsWith(`tm_${kind}_`)', '!secret || !new RegExp(`^(?:lb|tm)_${kind}_`).test(secret)');
  }
  if (file === 'apps/app/src/components/brand.tsx') {
    text = text.replace('/** Logbird mark: a "T" waymark with the accent trail dot. */', '/** Logbird bird and newest log entry. */');
    text = text.replace(
      / {6}<path className="stroke-background" d="M9 10h14M16 10v13"[^\n]+\n {6}<circle[^\n]+/,
      `      <path className="fill-background" d="${bird}" />\n      <circle className="fill-foreground" cx="19.6" cy="13.9" r="1.35" />\n      <path className="stroke-background" d="M6.5 25h11" fill="none" strokeLinecap="round" strokeWidth="2.4" />\n      <path d="M21 25h4.5" stroke="var(--brand)" strokeLinecap="round" strokeWidth="2.4" />`,
    );
  }
  // Lockups use the lowercase wordmark (docs/brand.md); prose keeps "Logbird".
  if (file === 'apps/app/src/components/brand.tsx') text = text.replace(/(<BrandMark \/>\r?\n\s*)Logbird(\r?\n)/, '$1logbird$2');
  if (file === 'packages/email/src/templates/components.tsx')
    text = text.replace(/(letterSpacing: '-0\.3px',[\s\S]*?\}\}\r?\n\s*>\r?\n\s*)Logbird(\r?\n)/, '$1logbird$2');
  if (file === 'apps/app/public/favicon.svg') text = favicon;
  if (file === 'packages/email/src/templates/components.tsx') {
    if (!text.includes('biome-ignore-all lint/suspicious/noArrayIndexKey'))
      text = `// biome-ignore-all lint/suspicious/noArrayIndexKey: Fixed bird pixel coordinates never reorder.\n${text}`;
    text = text.replace(
      'Wordmark: an HTML-only rendition of the app\'s "T" mark, so it survives image blocking and dark-mode inversion.',
      'Wordmark: an HTML table bird mark that survives image blocking.',
    );
    text = text.replace(/ {14}T\r?\n/, '              <EmailBird />\n');
    text = text.replace(/ {14}<img[^\n]+\n/, '              <EmailBird />\n');
    if (!text.includes('function EmailBird()'))
      text = text.replace(
        'function Wordmark(',
        "function EmailBird() {\n  const rows = [[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,1,1,1,0,0,0,0,0,0],[0,0,0,0,0,1,1,1,1,1,1,0,0,0,0,0],[0,0,0,0,1,1,1,1,1,0,1,1,0,0,0,0],[0,0,0,0,1,1,1,1,1,1,1,0,0,0,0,0],[0,0,0,1,1,1,1,1,1,1,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],[0,0,0,1,1,1,1,1,1,0,2,2,2,2,0,0],[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]];\n  return <table {...table} aria-hidden style={{ width: '26px', height: '26px', borderCollapse: 'collapse' }}><tbody>{rows.map((row, y) => <tr key={y}>{row.map((pixel, x) => <td key={x} style={{ width: '1.625px', height: '1.625px', padding: 0, fontSize: 0, lineHeight: 0, backgroundColor: pixel === 2 ? '#818cf8' : pixel === 1 ? light.markText : light.mark }} />)}</tr>)}</tbody></table>;\n}\n\nfunction Wordmark(",
      );
  }
  if (file.endsWith('.snap')) text = text.replace(/(Join Acme on Logbird\n)=+/, '$1====================');
  return text;
}
const changed = [];
for (const file of files) {
  if (excluded(file) || !existsSync(file)) continue;
  const bytes = readFileSync(file);
  if (bytes.includes(0)) continue;
  const input = bytes.toString('utf8');
  if (!Buffer.from(input).equals(bytes) || input.startsWith('version https://git-lfs.github.com/spec/')) continue;
  const output = rename(file, input);
  const target = file.replaceAll('trailmark', 'logbird').replaceAll('Trailmark', 'Logbird');
  if (output !== input || target !== file) {
    changed.push(file);
    if (!check) {
      writeFileSync(file, output);
      if (target !== file) renameSync(file, target);
    }
  }
}
console.log(changed.length ? `${check ? 'Pending' : 'Renamed'} (${changed.length}):\n${changed.join('\n')}` : 'Logbird rename is current.');
if (check && changed.length) process.exitCode = 1;
