import { useEffect, useRef } from 'react';
import { phoneVariantId, screenshotSrcSet, screenshotUrl } from '../lib/asset-url';
import { imageWidths, type ScreenshotEntry, screenshots, type Variant } from '../lib/media-manifest';

const FORMATS = ['avif', 'webp'] as const;

/** Loads the visible variant of the preceding screenshot eagerly (see Screenshot's `priority`). */
const EAGER_VISIBLE =
  "document.currentScript.previousElementSibling.querySelectorAll('img').forEach(function(i){if(i.getClientRects().length)i.loading='eager'})";
const PHONE = '(max-width: 639px)';

function ThemePicture({
  entry,
  theme,
  sizes,
  className,
  zoomLabel,
  priority,
}: {
  entry: ScreenshotEntry;
  theme: 'light' | 'dark';
  sizes: string;
  className?: string;
  /** The page's largest image above the fold: fetched at high priority. It stays lazy, so the hidden theme is never fetched. */
  priority?: boolean;
  /** When set, the picture links to its full-size image, so a phone reader can open it and zoom. */
  zoomLabel?: string;
}) {
  const image = useRef<HTMLImageElement>(null);
  // After a client-side navigation the inline script does not run: switch the visible variant here too.
  useEffect(() => {
    const element = image.current;
    if (priority && element && element.getClientRects().length > 0) element.loading = 'eager';
  }, [priority]);
  const pick = (variant: Variant) => (theme === 'dark' && variant.dark ? 'dark' : 'light');
  const desktopTheme = pick(entry);
  const widths = imageWidths(entry.width);
  const fullSize = screenshotUrl(entry.id, desktopTheme, widths.at(-1), 'webp');
  const picture = (
    <picture className={zoomLabel ? undefined : className}>
      {entry.phone
        ? FORMATS.map((format) => (
            <source
              height={entry.phone?.height}
              key={`phone-${format}`}
              media={PHONE}
              sizes="100vw"
              srcSet={screenshotSrcSet(phoneVariantId(entry.id), pick(entry.phone as Variant), format, [(entry.phone as Variant).width])}
              type={`image/${format}`}
              width={entry.phone?.width}
            />
          ))
        : null}
      {FORMATS.map((format) => (
        <source key={format} sizes={sizes} srcSet={screenshotSrcSet(entry.id, desktopTheme, format, widths)} type={`image/${format}`} />
      ))}
      <img
        alt={entry.alt}
        decoding="async"
        fetchPriority={priority ? 'high' : undefined}
        height={entry.height}
        loading="lazy"
        ref={image}
        sizes={sizes}
        src={fullSize}
        // The inline script may already have switched `loading` to eager before hydration.
        suppressHydrationWarning={priority}
        width={entry.width}
      />
    </picture>
  );
  if (!zoomLabel) {
    return picture;
  }
  return (
    <a aria-label={zoomLabel} className={className} href={fullSize} rel="noopener" target="_blank">
      {picture}
    </a>
  );
}

/**
 * A real console capture in both themes. The theme class is set before first paint (ThemeProvider's script), and CSS
 * hides the other variant; hidden lazy images are never fetched, so each visitor downloads exactly one image, with no
 * swap after hydration. Below 640px a phone capture replaces the shrunken desktop one when the entry has it.
 */
export function Screenshot({ id, sizes = '100vw', zoomLabel, priority }: { id: string; sizes?: string; zoomLabel?: string; priority?: boolean }) {
  const entry = screenshots.find((item) => item.id === id);
  if (!entry) {
    throw new Error(`Unknown screenshot: ${id}`);
  }
  const themed = Boolean(entry.dark || entry.phone?.dark);
  return (
    <>
      <div className="screenshot">
        {themed ? (
          <>
            <ThemePicture className="theme-light" entry={entry} priority={priority} sizes={sizes} theme="light" zoomLabel={zoomLabel} />
            <ThemePicture className="theme-dark" entry={entry} priority={priority} sizes={sizes} theme="dark" zoomLabel={zoomLabel} />
          </>
        ) : (
          <ThemePicture entry={entry} priority={priority} sizes={sizes} theme="light" zoomLabel={zoomLabel} />
        )}
      </div>
      {priority ? (
        // The theme class is set before first paint, so the hidden variant has no layout box. This switches only the
        // visible variant from lazy to eager as soon as it is parsed; the hidden one stays lazy and is never fetched.
        // biome-ignore lint/security/noDangerouslySetInnerHtml: a constant, CSP-hashed inline script with no input
        <script dangerouslySetInnerHTML={{ __html: EAGER_VISIBLE }} />
      ) : null}
    </>
  );
}
