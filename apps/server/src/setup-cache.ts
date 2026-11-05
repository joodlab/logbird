import { type SetupEventFacts, setupEventFacts } from '@trailmark/clickhouse';
import { clickhouse } from './clickhouse';

const cache = new Map<string, { expires: number; facts: SetupEventFacts }>();
export function invalidateSetup(projectId: string) {
  cache.delete(projectId);
}
export async function setupFacts(projectId: string) {
  const cached = cache.get(projectId);
  if (cached && cached.expires > Date.now()) {
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
    cache.set(projectId, { expires: Date.now() + 30_000, facts });
  }
  return facts;
}
