import { type SetupEventFacts, setupEventFacts } from '@logbird/clickhouse';
import { clickhouse } from './clickhouse';

const cache = new Map<string, { expires: number; generation: string; facts: SetupEventFacts }>();
export function invalidateSetup(projectId: string) {
  cache.delete(projectId);
}
/**
 * `generation` is the project's maintenance and export generations as read with the request (`setupGeneration`): any
 * destructive change (retention, sample removal, a purge, a repair) bumps one, so facts cached before it never answer
 * after it, in any instance, even within the 30-second window (#296 round-1 finding 11).
 */
export const setupGeneration = (project: { maintenanceGeneration: bigint | number; exportGeneration: bigint | number }) =>
  `${project.maintenanceGeneration}:${project.exportGeneration}`;
export async function setupFacts(projectId: string, generation: string) {
  const cached = cache.get(projectId);
  if (cached && cached.expires > Date.now() && cached.generation === generation) {
    cache.delete(projectId);
    cache.set(projectId, cached);
    return cached.facts;
  }
  const facts = await setupEventFacts(clickhouse, projectId);
  // Empty projects must observe first ingestion on the next onboarding poll.
  if (facts.firstEventAt) {
    if (cache.size >= 500) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }
    cache.set(projectId, { expires: Date.now() + 30_000, generation, facts });
  }
  return facts;
}
