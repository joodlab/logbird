import { CheckIcon, MinusIcon } from 'lucide-react';
import { Rich } from './rich';

export interface Guarantee {
  promise: string;
  limit: string;
}

/**
 * "What we promise" next to "where the promise ends", one row per guarantee. Reads as a table on every width. Both
 * columns take the copy files' inline marks (`code`, bold, emphasis), rendered by Rich. The column names come from the
 * page's content module and also prefix each cell for screen readers.
 */
export function Guarantees({
  items,
  headers,
  questions = false,
}: {
  items: Guarantee[];
  headers: { promise: string; limit: string };
  /** A question/answer table: no check and dash icons, which would read as yes/no. */
  questions?: boolean;
}) {
  return (
    <div className="panel overflow-hidden">
      <div aria-hidden="true" className="hidden grid-cols-2 border-b bg-[var(--surface-sunken)] md:grid">
        <p className="px-6 py-3 font-medium text-muted-foreground text-sm">{headers.promise}</p>
        <p className="border-s px-6 py-3 font-medium text-muted-foreground text-sm">{headers.limit}</p>
      </div>
      <ul>
        {items.map((item) => (
          <li className="grid border-b last:border-b-0 md:grid-cols-2" key={item.promise}>
            <p className="flex gap-3 px-5 pt-5 pb-2 md:px-6 md:py-5">
              {questions ? null : <CheckIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-outcome-success" />}
              <span>
                <span className="sr-only">{`${headers.promise}: `}</span>
                <Rich text={item.promise} />
              </span>
            </p>
            <p className="flex gap-3 px-5 pt-0 pb-5 text-muted-foreground md:border-s md:px-6 md:py-5">
              {questions ? null : <MinusIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />}
              <span>
                <span className="sr-only">{`${headers.limit}: `}</span>
                <Rich text={item.limit} />
              </span>
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
