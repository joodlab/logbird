import { SAMPLE_DATA_SOURCE } from '@logbird/contracts';
import { Button } from '@logbird/ui/components/ui/button';
import { cn } from '@logbird/ui/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { DatabaseIcon, Loader2Icon, Trash2Icon } from 'lucide-react';
import { PendingHint } from '@/components/pending-hint';
import { projectSetupQuery } from '@/lib/api/queries';
import { formatNumber } from '@/lib/format';
import { useCan } from '@/lib/permissions';
import { useConfirmRemoveSampleData } from './first-event-panel';
import { useSampleData } from './use-setup';

/**
 * Slim notice on Overview and Explorer while sample events are stored, so nobody mistakes them for real traffic.
 * Owners and admins remove them in one confirmation; members see who can.
 */
export function SampleDataBanner({ projectId, className }: { projectId: string; className?: string }) {
  const setup = useQuery(projectSetupQuery(projectId));
  const count = setup.data?.ingest.sampleEvents ?? 0;
  const manage = useCan()('sampleData.manage');
  const { remove } = useSampleData(projectId);
  const confirmRemove = useConfirmRemoveSampleData(count);
  if (count <= 0) return null;
  return (
    <div
      className={cn('tm-fade-in flex flex-wrap items-center gap-x-3 gap-y-1.5 border-brand/20 bg-brand/[0.05] px-4 py-2 text-[13px]', className)}
      data-testid="sample-data-banner"
      role="status"
    >
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <DatabaseIcon className="size-3.5 shrink-0 text-brand" />
        <span className="min-w-0">
          <span className="font-medium">Includes {formatNumber(count)} sample events</span>
          <span className="text-muted-foreground">
            {' '}
            · fictional data tagged <span className="font-mono text-foreground">source:{SAMPLE_DATA_SOURCE}</span>
          </span>
        </span>
      </span>
      {manage ? (
        <Button
          className="-my-1"
          data-testid="sample-data-banner-remove"
          disabled={remove.isPending}
          onClick={async () => {
            if (await confirmRemove()) remove.mutate();
          }}
          size="xs"
          variant="ghost"
        >
          {remove.isPending ? <Loader2Icon className="animate-spin" /> : <Trash2Icon />}
          Remove
        </Button>
      ) : (
        <span className="text-muted-foreground text-xs">An owner or admin can remove them</span>
      )}
      <PendingHint className="basis-full" pending={remove.isPending} slow="Removing the sample events and rebuilding the dashboards…" />
    </div>
  );
}
