import { Button } from '@logbird/ui/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@logbird/ui/components/ui/sheet';
import { type Theme, useTheme } from '@logbird/ui/theme';
import { useState } from 'react';
import { APP_URL, GITHUB_PUBLIC, GITHUB_URL } from '../env';
import { siteMap } from '../lib/site-map';

function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  return (
    <label className="inline-flex items-center gap-2">
      Theme
      <select className="theme-select" value={theme} onChange={(event) => setTheme(event.target.value as Theme)} aria-label="Color theme">
        <option value="light">Light</option>
        <option value="dark">Dark</option>
        <option value="system">System</option>
      </select>
    </label>
  );
}
function PrimaryNav({ close }: { close?: () => void }) {
  return (
    <nav aria-label="Primary">
      {siteMap
        .filter((page) => page.inNav)
        .map((page) => (
          <a key={page.path} href={page.path} onClick={close}>
            {page.title}
          </a>
        ))}
    </nav>
  );
}
function Actions() {
  return (
    <>
      <ThemeToggle />
      <a href={APP_URL}>Sign in</a>
      <Button render={<a href="/contact" />} nativeButton={false}>
        Join the waitlist
      </Button>
    </>
  );
}
export function SiteHeader() {
  const [open, setOpen] = useState(false);
  return (
    <header className="site-header">
      <a href="/" aria-label="Logbird home">
        <img className="wordmark theme-light" src="/brand/logbird-wordmark-light.svg" alt="Logbird" width="130" height="32" />
        <img className="wordmark theme-dark" src="/brand/logbird-wordmark-dark.svg" alt="Logbird" width="130" height="32" />
      </a>
      <div className="desktop-nav">
        <PrimaryNav />
      </div>
      <div className="header-actions">
        <Actions />
      </div>
      <div className="mobile-menu">
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger render={<Button variant="outline" />}>Menu</SheetTrigger>
          <SheetContent>
            <SheetHeader>
              <SheetTitle>Navigation</SheetTitle>
              <SheetDescription>Explore Logbird and choose a theme.</SheetDescription>
            </SheetHeader>
            <div className="mobile-nav">
              <PrimaryNav close={() => setOpen(false)} />
              <Actions />
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </header>
  );
}
export function SiteFooter() {
  const groups = [...new Set(siteMap.filter((page) => page.inFooter).map((page) => page.section))];
  return (
    <footer className="site-footer">
      <div className="footer-groups">
        {groups.map((section) => (
          <section key={section}>
            <h2>{section}</h2>
            <ul>
              {siteMap
                .filter((page) => page.inFooter && page.section === section)
                .map((page) => (
                  <li key={page.path}>
                    <a href={page.path}>{page.title}</a>
                  </li>
                ))}
            </ul>
          </section>
        ))}
      </div>
      <p>MIT licensed. {GITHUB_PUBLIC && <a href={GITHUB_URL}>Source on GitHub</a>}</p>
      <p>© 2026 Joodlab</p>
    </footer>
  );
}
