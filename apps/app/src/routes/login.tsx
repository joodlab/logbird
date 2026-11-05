import { createFileRoute, Outlet } from '@tanstack/react-router';
import { z } from 'zod';
import { BrandLockup } from '@/components/brand';

export const Route = createFileRoute('/login')({
  validateSearch: z.object({ redirect: z.string().optional(), email: z.string().optional() }),
  head: () => ({ meta: [{ title: 'Sign in · Trailmark' }] }),
  component: LoginLayout,
});

function LoginLayout() {
  return (
    <div className="relative flex min-h-svh flex-col">
      <div
        aria-hidden
        className="tm-grid-bg pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_at_top,black_15%,transparent_65%)]"
      />
      <header className="relative flex h-16 items-center px-6">
        <BrandLockup />
      </header>
      <main className="relative flex flex-1 items-start justify-center px-4 pt-[10vh] pb-16">
        <div className="tm-fade-in w-full max-w-[380px]">
          <Outlet />
        </div>
      </main>
      <footer className="relative flex h-14 items-center justify-center gap-3 text-muted-foreground text-xs">
        <span>Open-source audit trail · MIT</span>
        <span aria-hidden>·</span>
        <a className="hover:text-foreground" href="https://github.com/joodlab/trailmark" rel="noreferrer" target="_blank">
          GitHub
        </a>
      </footer>
    </div>
  );
}
