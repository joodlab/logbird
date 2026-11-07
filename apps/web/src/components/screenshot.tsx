import { imageWidths, type ScreenshotEntry, screenshots, type Variant } from '../lib/media-manifest';

const FORMATS = ['avif', 'webp'] as const;
const PHONE = '(max-width: 639px)';

const srcSet = (id: string, theme: 'light' | 'dark', format: string, widths: number[]) =>
  widths.map((width) => `/media/${id}-${theme}-${width}.${format} ${width}w`).join(', ');

function ThemePicture({ entry, theme, sizes, className }: { entry: ScreenshotEntry; theme: 'light' | 'dark'; sizes: string; className?: string }) {
  const pick = (variant: Variant) => (theme === 'dark' && variant.dark ? 'dark' : 'light');
  const desktopTheme = pick(entry);
  const widths = imageWidths(entry.width);
  return (
    <picture className={className}>
      {entry.phone
        ? FORMATS.map((format) => (
            <source
              height={entry.phone?.height}
              key={`phone-${format}`}
              media={PHONE}
              sizes="100vw"
              srcSet={srcSet(`${entry.id}-phone`, pick(entry.phone as Variant), format, [(entry.phone as Variant).width])}
              type={`image/${format}`}
              width={entry.phone?.width}
            />
          ))
        : null}
      {FORMATS.map((format) => (
        <source key={format} sizes={sizes} srcSet={srcSet(entry.id, desktopTheme, format, widths)} type={`image/${format}`} />
      ))}
      <img
        alt={entry.alt}
        decoding="async"
        height={entry.height}
        loading="lazy"
        sizes={sizes}
        src={`/media/${entry.id}-${desktopTheme}-${widths.at(-1)}.webp`}
        width={entry.width}
      />
    </picture>
  );
}

/**
 * A real console capture in both themes. The theme class is set before first paint (ThemeProvider's script), and CSS
 * hides the other variant; hidden lazy images are never fetched, so each visitor downloads exactly one image, with no
 * swap after hydration. Below 640px a phone capture replaces the shrunken desktop one when the entry has it.
 */
export function Screenshot({ id, sizes = '100vw' }: { id: string; sizes?: string }) {
  const entry = screenshots.find((item) => item.id === id);
  if (!entry) {
    throw new Error(`Unknown screenshot: ${id}`);
  }
  const themed = Boolean(entry.dark || entry.phone?.dark);
  return (
    <div className="screenshot">
      {themed ? (
        <>
          <ThemePicture className="theme-light" entry={entry} sizes={sizes} theme="light" />
          <ThemePicture className="theme-dark" entry={entry} sizes={sizes} theme="dark" />
        </>
      ) : (
        <ThemePicture entry={entry} sizes={sizes} theme="light" />
      )}
    </div>
  );
}
