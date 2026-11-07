import { type Button, buttonVariants } from '@logbird/ui/components/ui/button';
import { cn } from '@logbird/ui/lib/utils';
import { Link } from '@tanstack/react-router';
import type { ComponentProps, MouseEventHandler, ReactNode } from 'react';

type ButtonLinkProps = Pick<ComponentProps<typeof Button>, 'variant' | 'size'> & {
  children: ReactNode;
  className?: string;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
} & ({ to: string; href?: never } | { href: string; to?: never });

/** A link styled as a button. `to` is an internal route (client navigation); `href` is anything else. */
export function ButtonLink({ to, href, variant, size, className, children, onClick }: ButtonLinkProps) {
  const classes = cn(buttonVariants({ variant, size }), 'no-underline', className);
  if (to !== undefined) {
    return (
      <Link className={classes} onClick={onClick} to={to}>
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
