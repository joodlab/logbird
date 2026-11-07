import type { ReactNode } from 'react';

export interface Step {
  title: string;
  body: ReactNode;
  detail?: string;
}

/** Numbered steps on a shared rail; vertical on phones, horizontal from md. */
export function Steps({ items, vertical = false }: { items: Step[]; vertical?: boolean }) {
  if (vertical) {
    return (
      <ol className="relative grid gap-6">
        <span aria-hidden="true" className="absolute top-4 bottom-4 start-4 w-px bg-border" />
        {items.map((step, index) => (
          <li className="relative flex gap-4" key={step.title}>
            <span
              aria-hidden="true"
              className="relative z-10 inline-flex size-8 shrink-0 items-center justify-center rounded-full border bg-background font-mono text-sm"
            >
              {index + 1}
            </span>
            <div className="flex flex-col gap-1 pt-1">
              <h4 className="font-semibold">{step.title}</h4>
              <div className="body-copy text-muted-foreground text-sm leading-relaxed">{step.body}</div>
            </div>
          </li>
        ))}
      </ol>
    );
  }
  return (
    <ol className="relative grid gap-8 md:grid-cols-4 md:gap-6">
      <span
        aria-hidden="true"
        className="absolute top-4 bottom-4 start-4 w-px bg-border md:top-4 md:right-0 md:bottom-auto md:left-0 md:h-px md:w-auto"
      />
      {items.map((step, index) => (
        <li className="relative flex gap-4 md:flex-col md:gap-5" key={step.title}>
          <span
            aria-hidden="true"
            className="relative z-10 inline-flex size-8 shrink-0 items-center justify-center rounded-full border bg-background font-mono text-sm data-[last=true]:border-brand data-[last=true]:text-brand"
            data-last={index === items.length - 1}
          >
            {index + 1}
          </span>
          <div className="flex flex-col gap-2">
            <h3 className="h3">{step.title}</h3>
            <div className="body-copy text-muted-foreground leading-relaxed">{step.body}</div>
            {step.detail ? <p className="font-mono text-muted-foreground text-xs">{step.detail}</p> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Architecture at a glance: the README's mermaid diagram as accessible HTML. */
export function Architecture() {
  const node = 'panel flex flex-col gap-1 px-4 py-3';
  const arrow = 'hidden self-center text-[var(--subtle)] md:block';
  return (
    <figure className="flex flex-col gap-3">
      <div className="grid gap-3 md:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr] md:items-stretch">
        <div className={node}>
          <span className="font-medium text-sm">Your product</span>
          <span className="text-muted-foreground text-xs">SDK or HTTP, ingest key</span>
        </div>
        <span aria-hidden="true" className={arrow}>
          →
        </span>
        <div className={node}>
          <span className="font-medium text-sm">Logbird API</span>
          <span className="text-muted-foreground text-xs">Validates, answers 202 after the write</span>
        </div>
        <span aria-hidden="true" className={arrow}>
          →
        </span>
        <div className={`${node} border-brand/50`}>
          <span className="font-medium text-sm">ClickHouse</span>
          <span className="text-muted-foreground text-xs">Events, rollups, entity pages</span>
        </div>
        <span aria-hidden="true" className={arrow}>
          →
        </span>
        <div className={node}>
          <span className="font-medium text-sm">Console and read API</span>
          <span className="text-muted-foreground text-xs">Your team, and your own backend</span>
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-xl border border-dashed px-4 py-3 text-sm">
          <span className="font-medium">Postgres</span>
          <span className="text-muted-foreground"> · workspaces, projects, members, hashed keys</span>
        </div>
        <div className="rounded-xl border border-dashed px-4 py-3 text-sm">
          <span className="font-medium">Retention worker</span>
          <span className="text-muted-foreground"> · deletes expired events every hour, on Redis or Dragonfly</span>
        </div>
      </div>
      <figcaption className="sr-only">
        Your product sends events to the Logbird API, which writes them to ClickHouse. The console and the read API read from ClickHouse. Postgres
        stores workspaces, projects and hashed keys. A retention worker deletes expired events every hour.
      </figcaption>
    </figure>
  );
}
