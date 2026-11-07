import type { ReactNode } from 'react';
import { cx } from '../../lib/cx';

export interface StackedRow {
  key: string;
  /** Row header: the first column, rendered as `<th scope="row">`. */
  header: ReactNode;
  /** One cell per entry in `columns`. */
  cells: ReactNode[];
}

const breakpoints = {
  sm: { table: 'hidden sm:block', cards: 'sm:hidden' },
  md: { table: 'hidden md:block', cards: 'md:hidden' },
} as const;

/**
 * A real table on wide screens, and the same rows as stacked cards below `stackBelow`, so nothing scrolls sideways
 * at 390 px. Only one rendering is displayed at a time; the other is `display: none` and out of the accessibility tree.
 */
export function StackedTable({
  caption,
  headerLabel,
  columns,
  rows,
  stackBelow = 'md',
  cardLabels = true,
  headerWidth,
  highlightColumn,
  className,
}: {
  /** Describes the table for assistive technology. Visually hidden. */
  caption: string;
  /** Label of the row-header column. Visually hidden when the column is self-explanatory. */
  headerLabel: { text: string; visible?: boolean };
  columns: string[];
  rows: StackedRow[];
  stackBelow?: keyof typeof breakpoints;
  /** On cards, label each cell with its column name. Turn off for two-column tables. */
  cardLabels?: boolean;
  /** Tailwind width class for the row-header column, e.g. `w-[22%]`. */
  headerWidth?: string;
  /** Index into `columns` to mark with the brand dot (Logbird's own column). */
  highlightColumn?: number;
  className?: string;
}) {
  const bp = breakpoints[stackBelow];
  return (
    <div className={className}>
      <div className={cx(bp.table, 'panel overflow-hidden')}>
        <table className="table-site table-panel body-copy">
          <caption className="sr-only">{caption}</caption>
          <thead className="bg-[var(--surface-sunken)]">
            <tr>
              <th className={headerWidth} scope="col">
                {headerLabel.visible ? headerLabel.text : <span className="sr-only">{headerLabel.text}</span>}
              </th>
              {columns.map((column, index) => (
                <th key={column} scope="col">
                  <span className="inline-flex items-center gap-2">
                    {index === highlightColumn ? <span aria-hidden="true" className="size-1.5 rounded-full bg-brand" /> : null}
                    {column}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <th className="wrap-anywhere" scope="row">
                  {row.header}
                </th>
                {row.cells.map((cell, index) => (
                  <td className="wrap-anywhere" key={columns[index]}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul aria-label={caption} className={cx(bp.cards, 'grid gap-3')}>
        {rows.map((row) => (
          <li className="panel body-copy wrap-anywhere px-5 py-4" key={row.key}>
            <p className="font-semibold">{row.header}</p>
            {cardLabels ? (
              <dl className="mt-3 grid gap-3">
                {columns.map((column, index) => (
                  <div className="grid gap-1" key={column}>
                    <dt className="inline-flex items-center gap-2 font-medium text-muted-foreground text-xs uppercase tracking-wide">
                      {index === highlightColumn ? <span aria-hidden="true" className="size-1.5 rounded-full bg-brand" /> : null}
                      {column}
                    </dt>
                    <dd className="text-[0.9375rem] leading-relaxed">{row.cells[index]}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              row.cells.map((cell, index) => (
                <p className="mt-1 text-[0.9375rem] text-muted-foreground leading-relaxed" key={columns[index]}>
                  {cell}
                </p>
              ))
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
