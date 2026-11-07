import { CheckIcon, MinusIcon } from 'lucide-react';

export interface Guarantee {
  promise: string;
  limit: string;
}

/** "What we promise" next to "where the promise ends", one row per guarantee. Reads as a table on every width. */
export function Guarantees({ items }: { items: Guarantee[] }) {
  return (
    <div className="panel overflow-hidden">
      <div aria-hidden="true" className="hidden grid-cols-2 border-b bg-[var(--surface-sunken)] md:grid">
        <p className="px-6 py-3 font-medium text-muted-foreground text-sm">We guarantee</p>
        <p className="border-s px-6 py-3 font-medium text-muted-foreground text-sm">The limit</p>
      </div>
      <ul>
        {items.map((item) => (
          <li className="grid border-b last:border-b-0 md:grid-cols-2" key={item.promise}>
            <p className="flex gap-3 px-5 pt-5 pb-2 md:px-6 md:py-5">
              <CheckIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-outcome-success" />
              <span>
                <span className="sr-only">Guarantee: </span>
                {item.promise}
              </span>
            </p>
            <p className="flex gap-3 px-5 pt-0 pb-5 text-muted-foreground md:border-s md:px-6 md:py-5">
              <MinusIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <span>
                <span className="sr-only">Limit: </span>
                {item.limit}
              </span>
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
