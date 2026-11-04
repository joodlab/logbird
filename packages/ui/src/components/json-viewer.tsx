import { ChevronRightIcon } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../lib/utils';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function Primitive({ value }: { value: Json }) {
  if (value === null) return <span className="text-syntax-keyword">null</span>;
  if (typeof value === 'boolean') return <span className="text-syntax-keyword">{String(value)}</span>;
  if (typeof value === 'number') return <span className="text-syntax-number">{value}</span>;
  return <span className="break-all text-syntax-string">"{String(value)}"</span>;
}

function Node({
  name,
  value,
  depth,
  defaultExpandDepth,
  last,
}: {
  name?: string;
  value: Json;
  depth: number;
  defaultExpandDepth: number;
  last: boolean;
}) {
  const isObject = value !== null && typeof value === 'object';
  const [open, setOpen] = useState(depth < defaultExpandDepth);
  const comma = last ? null : <span className="text-syntax-punct">,</span>;
  const label =
    name === undefined ? null : (
      <>
        <span className="text-syntax-key">"{name}"</span>
        <span className="text-syntax-punct">: </span>
      </>
    );
  if (!isObject) {
    return (
      <div className="ps-4">
        {label}
        <Primitive value={value} />
        {comma}
      </div>
    );
  }
  const entries: [string | undefined, Json][] = Array.isArray(value) ? value.map((v) => [undefined, v]) : Object.entries(value);
  const [openCh, closeCh] = Array.isArray(value) ? ['[', ']'] : ['{', '}'];
  if (entries.length === 0) {
    return (
      <div className="ps-4">
        {label}
        <span className="text-syntax-punct">
          {openCh}
          {closeCh}
        </span>
        {comma}
      </div>
    );
  }
  return (
    <div className={cn(depth > 0 && 'ps-4')}>
      <button
        aria-expanded={open}
        className="-ms-4 inline-flex items-center rounded-sm text-start outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50"
        onClick={() => setOpen((o) => !o)}
        type="button"
      >
        <ChevronRightIcon className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        {label}
        <span className="text-syntax-punct">{openCh}</span>
        {open ? null : (
          <>
            <span className="px-1 text-muted-foreground text-xs">
              {entries.length} {Array.isArray(value) ? (entries.length === 1 ? 'item' : 'items') : entries.length === 1 ? 'key' : 'keys'}
            </span>
            <span className="text-syntax-punct">{closeCh}</span>
            {comma}
          </>
        )}
      </button>
      {open ? (
        <>
          {entries.map(([k, v], i) => (
            <Node defaultExpandDepth={defaultExpandDepth} depth={depth + 1} key={k ?? i} last={i === entries.length - 1} name={k} value={v} />
          ))}
          <div>
            <span className="text-syntax-punct">{closeCh}</span>
            {comma}
          </div>
        </>
      ) : null}
    </div>
  );
}

/** Collapsible, syntax-colored JSON tree. */
export function JsonViewer({ value, defaultExpandDepth = 2, className }: { value: unknown; defaultExpandDepth?: number; className?: string }) {
  return (
    <div className={cn('overflow-auto ps-4 font-mono text-[12px] leading-[1.6]', className)}>
      <Node defaultExpandDepth={defaultExpandDepth} depth={0} last value={(value ?? null) as Json} />
    </div>
  );
}
