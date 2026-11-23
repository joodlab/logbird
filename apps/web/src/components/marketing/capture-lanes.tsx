import { compareContent } from '../../content/compare';
import { cx } from '../../lib/cx';

type Lane = (typeof compareContent.bemiLanes.lanes)[number];
type LaneNode = Lane['nodes'][number] & { labelCode?: string; detail?: string; detailCode?: string; accent?: boolean };

function LaneRow({ title, nodes }: Lane) {
  return (
    <div className="grid gap-3 lg:grid-cols-[6rem_minmax(0,1fr)] lg:items-center">
      <p className="font-mono text-muted-foreground text-xs uppercase tracking-wider">{title}</p>
      <ol aria-label={compareContent.bemiLanes.laneLabel(title)} className="flex flex-col gap-2 lg:flex-row lg:items-stretch">
        {(nodes as readonly LaneNode[]).map((node, index) => (
          <li className="flex min-w-0 flex-1 flex-col gap-2 lg:flex-row lg:items-center" key={node.id}>
            {index > 0 ? (
              <span aria-hidden="true" className="self-center text-[var(--subtle)] leading-none max-lg:rotate-90">
                →
              </span>
            ) : null}
            <div className={cx('panel flex min-w-0 flex-1 flex-col gap-1 self-stretch px-4 py-3', node.accent && 'panel-accent')}>
              <span className="font-medium text-sm">
                {node.labelCode ? <code className="font-mono">{node.labelCode}</code> : null}
                {node.label}
              </span>
              {node.detail || node.detailCode ? (
                <span className="wrap-anywhere text-muted-foreground text-xs">
                  {node.detailCode ? <code className="font-mono">{node.detailCode}</code> : node.detail}
                </span>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Bemi and Logbird side by side. Words: content/compare.ts (`bemiLanes`). */
export function CaptureLanes() {
  const [bemi, logbird] = compareContent.bemiLanes.lanes;
  return (
    <figure className="flex flex-col gap-4">
      <div className="panel panel-sunken flex flex-col gap-6 p-5 lg:p-8">
        <LaneRow {...bemi} />
        <div aria-hidden="true" className="border-t border-dashed" />
        <LaneRow {...logbird} />
      </div>
      <figcaption className="text-muted-foreground text-sm">{compareContent.bemiLanes.caption}</figcaption>
    </figure>
  );
}
