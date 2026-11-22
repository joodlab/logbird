import { cx as cn } from '../../lib/cx';
import { Highlighted } from './code';

/**
 * The recommended envelope with one-line annotations. Each annotated key's line is marked in the JSON, and the
 * annotation list repeats the key so the pairing reads without colour. Words: content/home.ts (envelope).
 */
export function Envelope({
  className,
  frameTitle,
  lines,
  notes,
  requiredBadge,
}: {
  className?: string;
  frameTitle: string;
  lines: { text: string; key?: string }[];
  notes: { key: string; text: string; required?: boolean }[];
  requiredBadge: string;
}) {
  return (
    <div className={cn('grid gap-6 lg:grid-cols-[minmax(0,1.75fr)_minmax(0,1fr)] lg:gap-10', className)}>
      <div className="frame min-w-0">
        <div className="frame-bar">
          <span className="font-mono text-[11px] text-muted-foreground">{frameTitle}</span>
        </div>
        <pre className="overflow-x-auto py-4 font-mono text-[12.5px] leading-[1.9] sm:text-[13px]">
          <code>
            {lines.map((line) => (
              <span
                className={cn(
                  'block border-s-2 border-transparent ps-4 pe-4',
                  line.key === 'action' && 'border-brand bg-[color-mix(in_oklab,var(--brand)_8%,transparent)]',
                )}
                data-key={line.key}
                key={line.text}
              >
                <Highlighted code={line.text} language="json" />
              </span>
            ))}
          </code>
        </pre>
      </div>
      <dl className="flex flex-col divide-y self-center">
        {notes.map((note) => (
          <div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-3 py-3 first:pt-0 last:pb-0" key={note.key}>
            <dt className="font-mono text-sm">
              <span className={note.required ? 'text-brand' : undefined}>{note.key}</span>
            </dt>
            <dd className="text-muted-foreground text-sm leading-relaxed">
              {note.text}
              {note.required ? (
                <>
                  {/* A real space, so the text reads "…required field. required", not "field.required". */}{' '}
                  <span className="ms-1 rounded-full border px-2 py-0.5 font-medium text-[11px] text-foreground">{requiredBadge}</span>
                </>
              ) : null}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
