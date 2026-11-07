import { cn } from '@logbird/ui/lib/utils';
import { Clip } from '../clip';
import { Screenshot } from '../screenshot';

/** A real console screenshot in a quiet window frame. The caption says what the image proves. */
export function ScreenshotFrame({
  id,
  caption,
  sizes = '(min-width: 1152px) 1104px, calc(100vw - 2rem)',
  priority = false,
  className,
  label,
}: {
  id: string;
  caption?: string;
  sizes?: string;
  priority?: boolean;
  className?: string;
  /** Text in the window bar, e.g. the console page shown. */
  label?: string;
}) {
  return (
    <figure className={cn('flex flex-col gap-3', className)}>
      <div className="frame">
        <div aria-hidden="true" className="frame-bar">
          <i />
          <i />
          <i />
          {label ? <span className="ms-2 truncate font-mono text-[11px] text-muted-foreground">{label}</span> : null}
        </div>
        <Screenshot id={id} priority={priority} sizes={sizes} />
      </div>
      {caption ? <figcaption className="text-muted-foreground text-sm">{caption}</figcaption> : null}
    </figure>
  );
}

export function ClipFrame({ id, caption, label, className }: { id: string; caption?: string; label?: string; className?: string }) {
  return (
    <figure className={cn('flex flex-col gap-3', className)}>
      <div className="frame">
        <div aria-hidden="true" className="frame-bar">
          <i />
          <i />
          <i />
          {label ? <span className="ms-2 truncate font-mono text-[11px] text-muted-foreground">{label}</span> : null}
        </div>
        <Clip id={id} />
      </div>
      {caption ? <figcaption className="text-muted-foreground text-sm">{caption}</figcaption> : null}
    </figure>
  );
}
