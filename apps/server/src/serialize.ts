import { apiKeySchema, projectSchema, savedViewSchema } from '@logbird/contracts';
import type { ApiKey, Project, SavedView } from '@logbird/database';

type Creator = { createdBy: { id: string; name: string; email: string } | null };
export const serializeProject = (project: Project) =>
  projectSchema.parse({
    ...project,
    createdAt: project.createdAt.toISOString(),
    lastEventAt: null,
    eventsLast24h: 0,
  });
export const serializeKey = (key: ApiKey & Creator) =>
  apiKeySchema.parse({
    ...key,
    createdBy: key.createdBy ? { ...key.createdBy, name: key.createdBy.name || key.createdBy.email } : null,
    createdAt: key.createdAt.toISOString(),
    lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
    lastUsedUserAgent: key.lastUsedUserAgent ?? null,
    replacesKeyId: key.replacesKeyId ?? null,
    revokedAt: key.revokedAt?.toISOString() ?? null,
  });
export const serializeView = (view: SavedView & Creator) =>
  savedViewSchema.parse({
    ...view,
    createdBy: view.createdBy ? { ...view.createdBy, name: view.createdBy.name || view.createdBy.email } : null,
    createdAt: view.createdAt.toISOString(),
  });
export const creatorSelect = { createdBy: { select: { id: true, name: true, email: true } } } as const;
