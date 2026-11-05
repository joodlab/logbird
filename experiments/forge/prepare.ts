import { readFile, writeFile } from 'node:fs/promises';

// Keep vendor extensions outside the canonical spec.
for (const [name, source] of [
  ['public', 'public'],
  ['console', 'openapi'],
]) {
  const spec = JSON.parse(await readFile(`openapi/${source}.json`, 'utf8'));
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const operation of Object.values(item as Record<string, Record<string, unknown>>)) {
      if (!operation.operationId) continue;
      operation['x-forge-group-name'] = path.startsWith('/v1') ? 'events' : 'console';
      operation['x-forge-method-name'] = operation.operationId;
    }
  }
  await writeFile(`experiments/forge/${name}.input.json`, `${JSON.stringify(spec, null, 2)}\n`);
}
