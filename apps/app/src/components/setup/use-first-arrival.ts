import type { ProjectSetup } from '@logbird/contracts';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { firstEventToast } from '@/lib/onboarding';

/**
 * The first event arriving while the setup panel watches: true from then on (the panel celebrates), with `onArrive`
 * called once and a toast that says the same as the panel's card. Nothing happens when the project already had an
 * event when the panel first saw it.
 */
export function useFirstArrival(data: ProjectSetup | undefined, onArrive: () => void): boolean {
  const sawEmpty = useRef<boolean | null>(null);
  const [celebrate, setCelebrate] = useState(false);
  useEffect(() => {
    if (!data) return;
    if (sawEmpty.current === null) sawEmpty.current = !data.ingest.firstEventAt;
    else if (sawEmpty.current && data.ingest.firstEventAt) {
      sawEmpty.current = false;
      setCelebrate(true);
      onArrive();
      // A console test proves the pipeline, not the integration: say so instead of "your integration works", and once
      // the backend has sent events too, say that rather than asking for one.
      const arrived = firstEventToast(data.ingest);
      toast.success(arrived.title, { description: arrived.description });
    }
  }, [data, onArrive]);
  return celebrate;
}
