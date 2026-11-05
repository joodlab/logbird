import { useEffect } from 'react';

/**
 * Refines the route's static `head()` title once data it depends on has loaded (an entity's display name, say), so
 * every tab and history entry says what it shows. The route keeps a generic fallback ("Actor · Trailmark") that
 * stands until then; on unmount the fallback comes back unless the next route has already set its own title.
 */
export function useDocumentTitle(title: string | null | undefined) {
  useEffect(() => {
    if (!title || typeof document === 'undefined') return;
    const previous = document.title;
    document.title = title;
    return () => {
      if (document.title === title) document.title = previous;
    };
  }, [title]);
}
