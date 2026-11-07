import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifests = join(root, 'deploy/k3s');

function yamlFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? yamlFiles(path) : entry.name.endsWith('.yaml') ? [path] : [];
  });
}

// These manifests deliberately use block-style top-level metadata. Fail closed on
// a different shape; schema validation separately checks YAML/Kubernetes semantics.
function resource(document) {
  const lines = document.split(/\r?\n/);
  const kind = lines.find((line) => line.startsWith('kind: '))?.slice(6);
  if (kind === 'Kustomization') return { kind };
  const start = lines.indexOf('metadata:');
  assert.ok(start >= 0, `Missing top-level metadata for ${kind}`);
  const metadata = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && !line.startsWith(' ')) break;
    metadata.push(line);
  }
  const namespaces = metadata.filter((line) => line.startsWith('  namespace: '));
  assert.ok(namespaces.length <= 1, `Duplicate namespace field for ${kind}`);
  return {
    kind,
    name: metadata.find((line) => line.startsWith('  name: '))?.slice(8),
    namespace: namespaces[0]?.slice(13),
  };
}

function assertNamespace(value, file) {
  if (['Kustomization', 'Namespace', 'ClusterIssuer'].includes(value.kind)) return;
  if (relative(manifests, file).replaceAll('\\', '/') === 'platform/traefik-config.yaml') {
    assert.equal(value.kind, 'HelmChartConfig');
    assert.equal(value.name, 'traefik');
    assert.equal(value.namespace, 'kube-system');
    return;
  }
  assert.equal(value.namespace, 'logbird', `${value.kind}/${value.name}: explicit metadata.namespace: logbird required`);
}

test('every repo-owned namespaced manifest has an explicit namespace before raw apply', () => {
  let applicationResources = 0;
  for (const file of yamlFiles(manifests)) {
    for (const document of readFileSync(file, 'utf8')
      .split(/^---\s*$/m)
      .filter((part) => part.trim())) {
      const value = resource(document);
      assertNamespace(value, file);
      if (value.namespace === 'logbird') applicationResources++;
    }
  }
  assert.equal(applicationResources, 14);
});

test('a Kustomization namespace cannot mask a missing raw-object namespace', () => {
  const missing = resource('kind: NetworkPolicy\nmetadata:\n  name: default-deny-ingress\nspec:\n  podSelector: {}');
  assert.throws(() => assertNamespace(missing, join(manifests, 'network-policies.yaml')), /explicit metadata.namespace/);
});

test('raw application applies select logbird after creating the Namespace separately', () => {
  for (const name of ['cloud-operations.md', 'cloud-ingress.md']) {
    const document = readFileSync(join(root, 'docs', name), 'utf8');
    assert.match(document, /kubectl apply -f namespace\.yaml\n\s*kubectl -n logbird apply -f network-policies\.yaml/);
    for (const line of document.split('\n')) {
      if (!line.includes('apply -f')) continue;
      if (/network-policies\.yaml|config\.yaml|migration\/job\.yaml|platform\/certificates\.yaml/.test(line)) {
        const namespace = line.includes('platform/traefik-config.yaml') ? 'kube-system' : 'logbird';
        assert.ok(line.includes(`kubectl -n ${namespace} apply -f`), line);
      }
      if (line.includes('apply -f namespace.yaml')) assert.equal(line.trim(), 'kubectl apply -f namespace.yaml');
    }
  }
});
