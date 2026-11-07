import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';

/**
 * Pages with dynamic titles (an actor's name, an operation id) publish their last breadcrumb
 * here; static sections come from route `staticData.crumb`.
 */
const CrumbContext = createContext<{ crumb: string | null; setCrumb: (c: string | null) => void }>({ crumb: null, setCrumb: () => undefined });

export function CrumbProvider({ children }: { children: ReactNode }) {
  const [crumb, setCrumb] = useState<string | null>(null);
  return <CrumbContext value={{ crumb, setCrumb }}>{children}</CrumbContext>;
}

export function useCrumb(): string | null {
  return useContext(CrumbContext).crumb;
}

export function useSetCrumb(label: string | null | undefined): void {
  const { setCrumb } = useContext(CrumbContext);
  useEffect(() => {
    setCrumb(label ?? null);
    return () => setCrumb(null);
  }, [label, setCrumb]);
}

declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    /** Section label for the top-bar breadcrumb. */
    crumb?: string;
    /** Where the section crumb links (a route path with `$projectId`), when it is not the parent URL segment. */
    crumbTo?: string;
    /** Show the shared time-range control in the top bar. */
    range?: boolean;
    /** Range used when the URL has none (sparse pages want a wider window). */
    defaultRange?: string;
  }
}
