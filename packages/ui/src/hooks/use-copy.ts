import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Copy text to the clipboard; `copied` flips to true for `resetMs`. Resolves whether the copy happened: a blocked
 * clipboard whose fallback also fails reports `false` (and shows no "Copied"), so a once-only secret is never treated
 * as copied when it was not.
 */
export function useCopy(resetMs = 1600) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = useCallback(
    async (text: string) => {
      let ok = true;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // Fallback for insecure contexts (http on a LAN IP) where the async clipboard is blocked.
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.append(area);
        area.select();
        try {
          ok = document.execCommand('copy');
        } catch {
          ok = false;
        }
        area.remove();
      }
      if (!ok) return false;
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), resetMs);
      return true;
    },
    [resetMs],
  );

  return { copied, copy };
}
