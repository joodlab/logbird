import type { ReactNode } from 'react';

export interface FaqItem {
  q: string;
  /** Plain-text answer, also used for FAQPage JSON-LD. */
  a: string;
  /** Rendered answer when it needs links or code; defaults to `a`. */
  body?: ReactNode;
}

/** Questions as h3s with their answers, always open: no disclosure widget, no JavaScript. */
export function FaqList({ items }: { items: FaqItem[] }) {
  return (
    <div className="grid gap-x-12 gap-y-10 md:grid-cols-2">
      {items.map((item) => (
        <div className="flex flex-col gap-2 border-t pt-6" key={item.q}>
          <h3 className="h3">{item.q}</h3>
          <p className="body-copy text-muted-foreground leading-relaxed">{item.body ?? item.a}</p>
        </div>
      ))}
    </div>
  );
}
