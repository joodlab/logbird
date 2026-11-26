import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PACKAGES, SUMS, tarballName, verifyAssets } from './npm-release-assets.mjs';

const registry = 'https://registry.npmjs.org';

async function registryIntegrity(name, version) {
  const response = await fetch(`${registry}/${encodeURIComponent(name)}/${version}`);
  if (response.status === 404) return;
  if (!response.ok) throw new Error(`npm lookup for ${name}@${version} returned HTTP ${response.status}`);
  const { dist } = await response.json();
  if (!dist?.integrity) throw new Error(`npm returned no integrity for ${name}@${version}`);
  return dist.integrity;
}

export async function publishAssets(folder, version, lookup, publish) {
  const assets = verifyAssets(folder, version);
  for (const [index, { name }] of PACKAGES.entries()) {
    const { path } = assets[index];
    const integrity = `sha512-${createHash('sha512').update(readFileSync(path)).digest('base64')}`;
    const existing = await lookup(name, version);
    if (existing === integrity) {
      console.log(`Skipping ${name}@${version}: npm already has the same tarball integrity`);
      continue;
    }
    if (existing !== undefined) throw new Error(`${name}@${version} already exists on npm with different integrity`);
    await publish(path, 'latest');
  }
}

async function main(folder, version) {
  // GitHub's job condition compares strings case-insensitively.
  if (process.env.NPM_PUBLISH_ENABLED !== 'true') return;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Expected a stable release version X.Y.Z');
  mkdirSync(folder);
  const base = `https://github.com/${process.env.GITHUB_REPOSITORY}/releases/download/v${version}`;
  for (const file of [...PACKAGES.map(({ name }) => tarballName(name, version)), SUMS]) {
    const response = await fetch(`${base}/${file}`);
    if (!response.ok) throw new Error(`Release download for ${file} returned HTTP ${response.status}`);
    writeFileSync(join(folder, file), Buffer.from(await response.arrayBuffer()));
  }
  await publishAssets(folder, version, registryIntegrity, (path, tag) => {
    execFileSync('npm', ['publish', resolve(path), `--tag=${tag}`, `--registry=${registry}`], { stdio: 'inherit' });
  });
}

if (import.meta.main) await main(...process.argv.slice(2));
