import { FIXTURES } from '@/lib/api/transport';

/** Visible reminder that the console is running on dev fixtures, never the real API. */
export function FixtureBanner() {
  if (!FIXTURES) return null;
  return (
    <div className="pointer-events-none fixed bottom-3 left-1/2 z-50 hidden -translate-x-1/2 sm:block">
      <div className="pointer-events-auto flex items-center gap-2 rounded-full border bg-popover/95 px-3 py-1 text-[11px] text-muted-foreground shadow-sm backdrop-blur">
        <span className="size-1.5 rounded-full bg-outcome-denied" />
        Fixture mode — data is generated in the browser
        <button
          className="font-medium text-foreground underline-offset-2 hover:underline"
          onClick={() => {
            (window as unknown as { __trailmarkFixtures?: { reset: () => void } }).__trailmarkFixtures?.reset();
            window.location.assign('/login');
          }}
          type="button"
        >
          Reset
        </button>
      </div>
    </div>
  );
}
