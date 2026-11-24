import type { WebhookEndpoint } from '@logbird/database';
import { WEBHOOK_LOG_RETENTION_MS } from '@logbird/database/webhooks';

export type Late = { count: number; since: Date };
export type LateInput = Pick<WebhookEndpoint, 'id' | 'projectId' | 'deliveryWindowSeconds' | 'deliveryWindowChangedAt'>;
export type CountLate = (projectId: string, windows: { since: Date; windowSeconds: number }[]) => Promise<number[]>;

const HOUR_MS = 3_600_000;
/**
 * Where the late-event count starts: the first whole arrival hour at or after the later of the endpoint's last window
 * change and the delivery-log retention. The rollup counts by arrival hour, so starting on an hour boundary keeps every
 * response for the same endpoint consistent: a new endpoint or a just-changed window counts 0 until that hour begins.
 */
export const lateEventsSince = (endpoint: Pick<WebhookEndpoint, 'deliveryWindowChangedAt'>, now: Date) =>
  new Date(Math.ceil(Math.max(+endpoint.deliveryWindowChangedAt, +now - WEBHOOK_LOG_RETENTION_MS) / HOUR_MS) * HOUR_MS);

/**
 * Late-event counts per endpoint (#152): one count per project for its windowed endpoints, so endpoints of different
 * projects are never counted against each other's events. An endpoint without a window counts 0.
 */
export async function lateEvents(endpoints: readonly LateInput[], now: Date, count: CountLate): Promise<Map<string, Late>> {
  const late = new Map(endpoints.map((endpoint) => [endpoint.id, { count: 0, since: lateEventsSince(endpoint, now) }]));
  const byProject = new Map<string, LateInput[]>();
  for (const endpoint of endpoints) {
    if (endpoint.deliveryWindowSeconds === null) continue;
    byProject.set(endpoint.projectId, [...(byProject.get(endpoint.projectId) ?? []), endpoint]);
  }
  for (const [projectId, windowed] of byProject) {
    const counts = await count(
      projectId,
      windowed.map((endpoint) => ({ since: lateEventsSince(endpoint, now), windowSeconds: endpoint.deliveryWindowSeconds ?? 0 })),
    );
    for (const [index, endpoint] of windowed.entries()) {
      const entry = late.get(endpoint.id);
      if (entry) entry.count = counts[index] ?? 0;
    }
  }
  return late;
}
