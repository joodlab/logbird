import { apiKeySchema, projectSchema, savedViewSchema } from '@trailmark/contracts';
import type { ApiKey, Project, SavedView } from '@trailmark/database';

type Creator = { createdBy: { id: string; name: string } | null };
export const serializeProject = (project: Project) =>
  projectSchema.parse({
    ...project,
    createdAt: project.createdAt.toISOString(),
    // TODO(data-plane): populate these from ClickHouse once ingest/read routes land.
    lastEventAt: null,
    eventsLast24h: 0,
  });
export const serializeKey = (key: ApiKey & Creator) =>
  apiKeySchema.parse({
    ...key,
    createdAt: key.createdAt.toISOString(),
    lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
    revokedAt: key.revokedAt?.toISOString() ?? null,
  });
export const serializeView = (view: SavedView & Creator) => savedViewSchema.parse({ ...view, createdAt: view.createdAt.toISOString() });
export const creatorSelect = { createdBy: { select: { id: true, name: true } } } as const;
