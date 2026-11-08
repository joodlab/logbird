import type { EntityKind } from '@logbird/contracts';
import { Button } from '@logbird/ui/components/ui/button';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { BookmarkCheckIcon, BookmarkPlusIcon, Loader2Icon } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { keys, viewsQuery } from '@/lib/api/queries';
import { splitTargetId } from '@/lib/entities';
import { rangeLabel } from '@/lib/range';
import { useCopyViewLink, type ViewLabelField, viewSearch } from '@/lib/views';

/** "Bayt Al Rimal — last 7 days". */
export function entityViewName(name: string, range: string): string {
  const label = rangeLabel(range);
  return `${name} — ${label.charAt(0).toLowerCase()}${label.slice(1)}`.slice(0, 80);
}

/**
 * One click from an entity page (tenant, actor, record, executor) saves "<name> — <range>" as a workspace view of every
 * event involving it, labelled with the entity's display name so the card reads "Tenant: Bayt Al Rimal". Saving the
 * same view twice just offers the existing one.
 */
export function SaveEntityViewButton({
  projectId,
  kind,
  entityId,
  name,
  query,
  range,
}: {
  projectId: string;
  kind: EntityKind;
  entityId: string;
  /** Display name; the raw id when the entity has none. */
  name: string;
  /** The entity's explorer query (`entityQuery`). */
  query: string;
  range: string;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const views = useQuery(viewsQuery(projectId));
  const copyLink = useCopyViewLink();
  const viewName = entityViewName(name, range);
  const existing = views.data?.find((v) => v.name === viewName && (v.state.q ?? '') === query && (v.state.range ?? '24h') === range);
  const open = (view: { id: string; state: Parameters<typeof viewSearch>[0]['state'] }) =>
    navigate({ to: '/p/$projectId/events', params: { projectId }, search: viewSearch(view) });
  const value = kind === 'target' ? splitTargetId(entityId).id : entityId;
  const save = useMutation({
    mutationFn: () =>
      api.views.create(projectId, {
        name: viewName,
        description: null,
        state: {
          q: query,
          lang: 'query',
          range,
          ...(name && name !== value ? { labels: [{ field: kind as ViewLabelField, value, label: name.slice(0, 200) }] } : {}),
        },
      }),
    onSuccess: async (view) => {
      await queryClient.invalidateQueries({ queryKey: [...keys.project(projectId), 'views'] });
      toast.success(`Saved “${view.name}”`, {
        description: 'It is in Saved views and the sidebar for everyone in the workspace.',
        action: { label: 'Copy link', onClick: () => copyLink(projectId, view) },
      });
    },
    onError: (error) => toast.error('Could not save the view', { description: errorMessage(error) }),
  });

  if (existing) {
    return (
      <Button
        data-testid="entity-view-saved"
        onClick={() => open(existing)}
        size="sm"
        title={`Open the saved view “${existing.name}”`}
        variant="outline"
      >
        <BookmarkCheckIcon className="text-brand" />
        Saved view
      </Button>
    );
  }
  return (
    <Button
      data-testid="save-entity-view"
      disabled={save.isPending || views.isPending}
      onClick={() => save.mutate()}
      size="sm"
      title={`Save “${viewName}” as a view everyone in the workspace can open`}
      variant="outline"
    >
      {save.isPending ? <Loader2Icon className="animate-spin" /> : <BookmarkPlusIcon />}
      Save as view
    </Button>
  );
}
