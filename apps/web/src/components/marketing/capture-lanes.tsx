import type { ReactNode } from 'react';
import { cx } from '../../lib/cx';

interface Node {
  id: string;
  label: ReactNode;
  detail?: ReactNode;
  accent?: boolean;
}

function Lane({ title, nodes }: { title: string; nodes: Node[] }) {
  return (
    <div className="grid gap-3 lg:grid-cols-[6rem_minmax(0,1fr)] lg:items-center">
      <p className="font-mono text-muted-foreground text-xs uppercase tracking-wider">{title}</p>
      <ol aria-label={`${title}: from your app to stored history`} className="flex flex-col gap-2 lg:flex-row lg:items-stretch">
        {nodes.map((node, index) => (
          <li className="flex min-w-0 flex-1 flex-col gap-2 lg:flex-row lg:items-center" key={node.id}>
            {index > 0 ? (
              <span aria-hidden="true" className="self-center text-[var(--subtle)] leading-none max-lg:rotate-90">
                →
              </span>
            ) : null}
            <div className={cx('panel flex min-w-0 flex-1 flex-col gap-1 self-stretch px-4 py-3', node.accent && 'panel-accent')}>
              <span className="font-medium text-sm">{node.label}</span>
              {node.detail ? <span className="wrap-anywhere text-muted-foreground text-xs">{node.detail}</span> : null}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Bemi and Logbird side by side: row changes captured from the WAL, versus actions your code reports. No logos. */
export function CaptureLanes() {
  return (
    <figure className="flex flex-col gap-4">
      <div className="panel panel-sunken flex flex-col gap-6 p-5 lg:p-8">
        <Lane
          nodes={[
            { id: 'app', label: 'Your app' },
            { id: 'postgres', label: 'Postgres' },
            { id: 'wal', label: 'Write-ahead log' },
            { id: 'bemi', label: 'Bemi' },
            {
              id: 'changes',
              label: (
                <>
                  <code className="font-mono">changes</code> table
                </>
              ),
              detail: 'table, primary_key, operation, before, after, context',
              accent: true,
            },
          ]}
          title="Bemi"
        />
        <div aria-hidden="true" className="border-t border-dashed" />
        <Lane
          nodes={[
            { id: 'code', label: 'Your app code', detail: <code className="font-mono">audit('booking.cancelled')</code> },
            { id: 'logbird', label: 'Logbird' },
            { id: 'explorer', label: 'Explorer', detail: 'actor, tenant, executor, targets, changes', accent: true },
          ]}
          title="Logbird"
        />
      </div>
      <figcaption className="text-muted-foreground text-sm">
        Bemi reads every row change from Postgres's write-ahead log. Logbird stores the actions your code reports, including ones that never touch
        your database.
      </figcaption>
    </figure>
  );
}
