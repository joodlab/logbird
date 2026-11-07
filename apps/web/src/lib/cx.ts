/** Joins class names. The site avoids tailwind-merge, so callers must not pass conflicting utilities. */
export function cx(...classes: unknown[]): string {
  return classes.filter((value): value is string => typeof value === 'string' && value.length > 0).join(' ');
}
