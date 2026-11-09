import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function checkVersions(manifests, tag) {
  const version = manifests.find(([file]) => file === 'package.json')?.[1].version;
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? '')) throw new Error('Root version must be X.Y.Z.');
  if (tag !== undefined && tag !== `v${version}`) throw new Error(`Tag ${tag} must match v${version}.`);
  const mismatches = manifests.filter(([, manifest]) => manifest.version !== version).map(([file]) => file);
  if (mismatches.length) throw new Error(`Package versions must all equal ${version}: ${mismatches.join(', ')}`);
  return version;
}

export function repositoryVersion(tag) {
  const files = execFileSync('git', ['ls-files', '-z', '--', 'package.json', '**/package.json'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  return checkVersions(
    files.map((file) => [file, JSON.parse(readFileSync(file, 'utf8'))]),
    tag,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(repositoryVersion(process.argv[2]));
}
