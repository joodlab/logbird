import { useTheme } from '@logbird/ui/theme';
import { imageWidths, type ScreenshotEntry, screenshots } from '../lib/media-manifest';

const FORMATS = ['avif', 'webp'] as const;

function srcSet(entry: ScreenshotEntry, theme: 'light' | 'dark', format: string) {
  return imageWidths(entry.width)
    .map((width) => `/media/${entry.id}-${theme}-${width}.${format} ${width}w`)
    .join(', ');
}

/**
 * One <picture> per screenshot, so only one theme variant is ever downloaded.
 * Before hydration (and while the visitor's theme is "system") the dark sources are selected with
 * `prefers-color-scheme`; once a visitor picks a theme explicitly, only that theme's sources are rendered.
 */
export function Screenshot({ id, sizes = '100vw', priority = false }: { id: string; sizes?: string; priority?: boolean }) {
  const { theme } = useTheme();
  const entry = screenshots.find((item) => item.id === id);
  if (!entry) {
    throw new Error(`Unknown screenshot: ${id}`);
  }
  const hasDark = Boolean(entry.dark);
  const forced = theme === 'system' ? null : theme;
  const fallbackTheme = forced === 'dark' && hasDark ? 'dark' : 'light';
  const widths = imageWidths(entry.width);
  return (
    <div className="screenshot">
      <picture>
        {hasDark && forced === null
          ? FORMATS.map((format) => (
              <source
                key={`dark-${format}`}
                media="(prefers-color-scheme: dark)"
                sizes={sizes}
                srcSet={srcSet(entry, 'dark', format)}
                type={`image/${format}`}
              />
            ))
          : null}
        {FORMATS.map((format) => (
          <source key={format} sizes={sizes} srcSet={srcSet(entry, fallbackTheme, format)} type={`image/${format}`} />
        ))}
        <img
          alt={entry.alt}
          decoding="async"
          fetchPriority={priority ? 'high' : undefined}
          height={entry.height}
          loading={priority ? 'eager' : 'lazy'}
          sizes={sizes}
          src={`/media/${entry.id}-${fallbackTheme}-${widths.at(-1)}.webp`}
          width={entry.width}
        />
      </picture>
    </div>
  );
}
