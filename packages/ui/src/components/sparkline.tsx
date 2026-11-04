import { useId } from 'react';
import { cn } from '../lib/utils';

/** Lightweight SVG sparkline (no chart library) for KPI footers and table cells. */
export function Sparkline({
  values,
  className,
  color = 'var(--brand)',
  height = 28,
  fill = true,
}: {
  values: number[];
  className?: string;
  color?: string;
  height?: number;
  fill?: boolean;
}) {
  const id = useId().replace(/:/g, '');
  if (values.length < 2) return <div className={cn('w-full', className)} style={{ height }} />;
  const max = Math.max(...values, 1);
  const w = 100;
  const step = w / (values.length - 1);
  const points = values.map((v, i) => [i * step, height - 2 - (v / max) * (height - 4)] as const);
  const line = points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  const area = `${line} L${w},${height} L0,${height} Z`;
  return (
    <svg aria-hidden className={cn('w-full overflow-visible', className)} height={height} preserveAspectRatio="none" viewBox={`0 0 ${w} ${height}`}>
      <defs>
        <linearGradient id={`spark-${id}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.22} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      {fill ? <path d={area} fill={`url(#spark-${id})`} /> : null}
      <path d={line} fill="none" stroke={color} strokeLinejoin="round" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
