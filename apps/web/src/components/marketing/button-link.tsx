import { Link } from '@tanstack/react-router';
import type { MouseEventHandler, ReactNode } from 'react';
import { cx } from '../../lib/cx';
import { siteMap } from '../../lib/site-map';

/*
 * The console's button look (packages/ui/src/components/ui/button.tsx) for links. Mirrored as plain class strings so
 * marketing pages don't ship @base-ui's Button and tailwind-merge just to style anchors. Keep in sync with the
 * console's variants when they change.
 */
const base =
  'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-transparent bg-clip-padding text-center font-medium text-sm no-underline outline-none transition-all select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:translate-y-px [&_svg]:pointer-events-none [&_svg]:shrink-0';
const variants = {
  default: 'bg-primary text-primary-foreground hover:bg-primary/80',
  outline: 'border-border bg-background shadow-xs hover:bg-muted hover:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50',
  ghost: 'hover:bg-muted hover:text-foreground dark:hover:bg-muted/50',
  link: 'text-brand underline-offset-4 hover:underline',
} as const;
const sizes = {
  default: 'h-(--control-size-default) px-3',
  sm: 'h-(--control-size-compact) px-2.5',
  lg: 'h-(--control-size-large) px-4 text-[15px]',
} as const;

type ButtonLinkProps = {
  variant?: keyof typeof variants;
  size?: keyof typeof sizes;
  children: ReactNode;
  className?: string;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
  search?: Record<string, string>;
} & ({ to: string; href?: never } | { href: string; to?: never });

/** Internal links to pages that aren't designed yet (site-map `ready: false`) render nothing until those pages ship. */
const unreadyPaths = new Set(siteMap.filter((page) => !page.ready).map((page) => page.path));

/** A link styled as a button. `to` is an internal route (client navigation); `href` is anything else. */
export function ButtonLink({ to, href, variant = 'default', size = 'default', className, children, onClick, search }: ButtonLinkProps) {
  if (to !== undefined && unreadyPaths.has(to)) {
    return null;
  }
  const classes = cx(base, variants[variant], variant === 'link' ? 'h-auto px-0' : sizes[size], className);
  if (to !== undefined) {
    return (
      // A call to action is never "current" for a sub-path: exact matching keeps the 404 page's "Product tour" button
      // inactive at /product/x, as it is in the prerendered 404.html that URL hydrates. The query string never matters:
      // /contact?status=… hydrates the same contact/index.html.
      <Link activeOptions={{ exact: true, includeSearch: false }} className={classes} onClick={onClick} search={search} to={to}>
        {children}
      </Link>
    );
  }
  return (
    <a className={classes} href={href} onClick={onClick}>
      {children}
    </a>
  );
}
