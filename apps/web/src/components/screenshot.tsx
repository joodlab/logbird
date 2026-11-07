import { imageWidths, type ScreenshotEntry, screenshots } from '../lib/media-manifest';

function ImageVariant({
  entry,
  theme,
  sizes,
  priority,
  switchTheme = true,
}: {
  entry: ScreenshotEntry;
  theme: 'light' | 'dark';
  sizes: string;
  priority: boolean;
  switchTheme?: boolean;
}) {
  const widths = imageWidths(entry.width);
  const srcSet = (format: string) => widths.map((width) => `/media/${entry.id}-${theme}-${width}.${format} ${width}w`).join(', ');
  return (
    <picture className={switchTheme ? (theme === 'dark' ? 'theme-dark' : 'theme-light') : undefined}>
      <source type="image/avif" srcSet={srcSet('avif')} sizes={sizes} />
      <source type="image/webp" srcSet={srcSet('webp')} sizes={sizes} />
      <img
        src={`/media/${entry.id}-${theme}-${widths.at(-1)}.webp`}
        alt={entry.alt}
        width={entry.width}
        height={entry.height}
        sizes={sizes}
        loading={priority ? 'eager' : 'lazy'}
        decoding="async"
        fetchPriority={priority ? 'high' : undefined}
      />
    </picture>
  );
}
export function Screenshot({ id, sizes = '100vw', priority = false }: { id: string; sizes?: string; priority?: boolean }) {
  const entry = screenshots.find((item) => item.id === id);
  if (!entry) {
    throw new Error(`Unknown screenshot: ${id}`);
  }
  return (
    <div className="screenshot">
      {entry.dark ? (
        <>
          <ImageVariant entry={entry} theme="light" sizes={sizes} priority={priority} />
          <ImageVariant entry={entry} theme="dark" sizes={sizes} priority={priority} />
        </>
      ) : (
        <ImageVariant entry={entry} theme="light" sizes={sizes} priority={priority} switchTheme={false} />
      )}
    </div>
  );
}
