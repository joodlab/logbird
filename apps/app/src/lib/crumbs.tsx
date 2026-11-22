import { useLocation } from '@tanstack/react-router';
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';

/**
 * Pages with dynamic titles (an actor's name, an operation id) publish their last breadcrumb
 * here; static sections come from route `staticData.crumb`.
 */
type Crumb = { label: string; path: string } | null;
const CrumbContext = createContext<{ crumb: Crumb; setCrumb: (c: Crumb) => void }>({ crumb: null, setCrumb: () => undefined });

export function CrumbProvider({ children }: { children: ReactNode }) {
  const [crumb, setCrumb] = useState<Crumb>(null);
  return <CrumbContext value={{ crumb, setCrumb }}>{children}</CrumbContext>;
}

/** The current page's dynamic crumb. One set by the previous page (still in state for a render) never shows here. */
export function useCrumb(): string | null {
  const { crumb } = useContext(CrumbContext);
  const { pathname } = useLocation();
  return crumb && crumb.path === pathname ? crumb.label : null;
}

export function useSetCrumb(label: string | null | undefined): void {
  const { setCrumb } = useContext(CrumbContext);
  const { pathname } = useLocation();
  useEffect(() => {
    setCrumb(label ? { label, path: pathname } : null);
    return () => setCrumb(null);
  }, [label, pathname, setCrumb]);
}

declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    /** Section label for the top-bar breadcrumb. */
    crumb?: string;
    /** Where the section crumb links (a route path with `$projectId`), when it is not the parent URL segment. */
    crumbTo?: string;
    /** Search params for the section crumb's link (kept with the current range). */
    crumbSearch?: Record<string, string>;
    /** Show the shared time-range control in the top bar. */
    range?: boolean;
    /** Range used when the URL has none (sparse pages want a wider window). */
    defaultRange?: string;
    /**
     * Keep a range the reader picks even when it equals the default (entity pages: "no range" means full history, so
     * a chosen 24 hours must stay in the URL). Other pages drop the default to return to their own.
     */
    keepChosenRange?: boolean;
  }
}
