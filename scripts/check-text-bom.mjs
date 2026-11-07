import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '*.md', '*.sql'], {
  encoding: 'utf8',
})
  .split('\0')
  .filter(Boolean);
const signatures = ['efbbbf', 'fffe', 'feff', '0000feff'].map((hex) => Buffer.from(hex, 'hex'));
// Common UTF-8-as-Windows-1252 corruption across Latin-1 and punctuation/box glyphs.
const mojibake = /[\u00c2\u00c3\u00e2][\^@-\u00bf\u0152\u0153\u0160\u0161\u0178\u017d\u017e\u0192\u02c6\u02dc\u2013-\u2122]/u;
const failures = files.flatMap((file) => {
  if (!existsSync(file)) return [];
  const bytes = readFileSync(file);
  const problems = [];
  if (signatures.some((signature) => bytes.subarray(0, signature.length).equals(signature))) problems.push(`${file}: BOM`);
  for (const [index, line] of bytes.toString('utf8').split(/\r?\n/).entries()) {
    if (mojibake.test(line)) problems.push(`${file}:${index + 1}: possible mojibake`);
  }
  return problems;
});
if (failures.length) {
  console.error(`Fix text encoding in these Markdown/SQL files:\n${failures.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(`PASS BOM/mojibake check: ${files.length} Markdown/SQL files`);
}
