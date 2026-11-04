import type { LucideIcon } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { cn } from '../lib/utils';

/** Stable hue per id so the same actor always gets the same avatar color. */
function hue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return h;
}

function initialsOf(name: string): string {
  const parts = name
    .replace(/\(.*?\)/g, '')
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return (parts[0] ?? '?').slice(0, 2).toUpperCase();
  return `${parts[0]?.[0] ?? ''}${parts.at(-1)?.[0] ?? ''}`.toUpperCase();
}

interface EntityAvatarProps {
  id: string;
  name: string;
  icon?: LucideIcon;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  square?: boolean;
  className?: string;
}

const SIZES = { xs: 'size-4 text-[8px]', sm: 'size-5 text-[9px]', md: 'size-7 text-[11px]', lg: 'size-11 text-sm' } as const;

export function EntityAvatar({ id, name, icon: Icon, size = 'sm', square = false, className }: EntityAvatarProps) {
  const h = hue(id || name);
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex shrink-0 items-center justify-center bg-[oklch(0.93_0.045_var(--h))] font-semibold text-[oklch(0.42_0.11_var(--h))] dark:bg-[oklch(0.33_0.07_var(--h))] dark:text-[oklch(0.88_0.07_var(--h))]',
        square ? 'rounded-md' : 'rounded-full',
        SIZES[size],
        className,
      )}
      style={{ '--h': h } as CSSProperties}
    >
      {Icon ? <Icon className={size === 'lg' ? 'size-5' : size === 'md' ? 'size-3.5' : 'size-3'} /> : initialsOf(name || id)}
    </span>
  );
}

interface EntityChipProps {
  id: string;
  name?: string;
  icon?: LucideIcon;
  /** Secondary mono text (type or id). */
  meta?: ReactNode;
  square?: boolean;
  className?: string;
  size?: 'sm' | 'md';
}

/** Avatar + name (+ mono id/type). Wrap in a Link to make it navigable. */
export function EntityChip({ id, name, icon, meta, square, className, size = 'sm' }: EntityChipProps) {
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)}>
      <EntityAvatar icon={icon} id={id} name={name || id} size={size === 'md' ? 'md' : 'sm'} square={square} />
      <span className="truncate" dir="auto">
        {name || <span className="font-mono text-[12px]">{id}</span>}
      </span>
      {meta ? <span className="shrink-0 truncate font-mono text-[11px] text-muted-foreground">{meta}</span> : null}
    </span>
  );
}
