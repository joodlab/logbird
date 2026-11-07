import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '*.md', '*.sql'], {
  encoding: 'utf8',
})
  .split('\0')
  .filter(Boolean);
const signatures = ['efbbbf', 'fffe', 'feff', '0000feff'].map((hex) => Buffer.from(hex, 'hex'));
const failures = files.filter((file) => {
  if (!existsSync(file)) return false;
  const bytes = readFileSync(file);
  return signatures.some((signature) => bytes.subarray(0, signature.length).equals(signature));
});
if (failures.length) {
  console.error(`Remove the byte-order mark from these Markdown/SQL files:\n${failures.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(`PASS BOM check: ${files.length} Markdown/SQL files`);
}
