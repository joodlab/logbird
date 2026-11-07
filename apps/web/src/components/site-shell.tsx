import { type Theme, useTheme } from '@logbird/ui/theme';
import { Link } from '@tanstack/react-router';
import { MenuIcon, MonitorIcon, MoonIcon, SunIcon, XIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { APP_URL, GITHUB_PUBLIC, GITHUB_URL } from '../env';
import { siteMap } from '../lib/site-map';
import { ButtonLink } from './marketing/button-link';

const themes: { value: Theme; label: string; Icon: typeof SunIcon }[] = [
  { value: 'light', label: 'Light theme', Icon: SunIcon },
  { value: 'dark', label: 'Dark theme', Icon: MoonIcon },
  { value: 'system', label: 'System theme', Icon: MonitorIcon },
];

function ThemeSwitch() {
  const { theme, setTheme } = useTheme();
  return (
    <fieldset className="inline-flex items-center gap-0.5 rounded-full border bg-background p-0.5">
      <legend className="sr-only">Color theme</legend>
      {themes.map(({ value, label, Icon }) => (
        <button
          aria-label={label}
          aria-pressed={theme === value}
          className="inline-flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground aria-pressed:bg-muted aria-pressed:text-foreground"
          key={value}
          onClick={() => setTheme(value)}
          title={label}
          type="button"
        >
          <Icon aria-hidden="true" className="size-4" />
        </button>
      ))}
    </fieldset>
  );
}

const navPages = siteMap.filter((page) => page.inNav);

function Wordmark() {
  return (
    <Link aria-label="Logbird home" className="flex shrink-0 items-center rounded-md" to="/">
      <img alt="" className="wordmark theme-light" height="28" src="/brand/logbird-wordmark-light.svg" width="114" />
      <img alt="" className="wordmark theme-dark" height="28" src="/brand/logbird-wordmark-dark.svg" width="114" />
    </Link>
  );
}

export function SiteHeader() {
  const [scrolled, setScrolled] = useState(false);
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  const closeMenu = () => {
    if (menu.current) {
      menu.current.open = false;
    }
  };
  return (
    <header className="site-header" data-scrolled={scrolled}>
      <div className="container-site flex h-full items-center gap-6">
        <Wordmark />
        <nav aria-label="Primary" className="hidden items-center lg:flex">
          {navPages.map((page) => (
            <Link activeOptions={{ exact: page.path === '/' }} className="nav-link" key={page.path} to={page.path}>
              {page.title}
            </Link>
          ))}
        </nav>
        <div className="ms-auto hidden items-center gap-2 lg:flex">
          <ThemeSwitch />
          <a className="nav-link" href={APP_URL}>
            Sign in
          </a>
          <ButtonLink to="/contact">Join the waitlist</ButtonLink>
        </div>
        <details className="mobile-menu ms-auto lg:hidden" ref={menu}>
          <summary aria-label="Menu" className="inline-flex size-11 items-center justify-center rounded-md border bg-background text-foreground">
            <MenuIcon aria-hidden="true" className="icon-open size-5" />
            <XIcon aria-hidden="true" className="icon-close size-5" />
          </summary>
          <div className="mobile-menu-panel">
            <nav aria-label="Mobile" className="container-site flex flex-col py-3">
              {navPages.map((page) => (
                <Link
                  className="flex min-h-12 items-center border-b font-medium text-base last:border-b-0"
                  key={page.path}
                  onClick={closeMenu}
                  to={page.path}
                >
                  {page.title}
                </Link>
              ))}
            </nav>
            <div className="container-site flex flex-col gap-3 border-t py-4">
              <ButtonLink className="w-full" onClick={closeMenu} size="lg" to="/contact">
                Join the waitlist
              </ButtonLink>
              <ButtonLink className="w-full" href={APP_URL} size="lg" variant="outline">
                Sign in
              </ButtonLink>
              <div className="flex items-center justify-between pt-1">
                <span className="text-muted-foreground text-sm">Theme</span>
                <ThemeSwitch />
              </div>
            </div>
          </div>
        </details>
      </div>
    </header>
  );
}

const footerGroups: { label: string; sections: string[] }[] = [
  { label: 'Product', sections: ['product'] },
  { label: 'Developers', sections: ['developers'] },
  { label: 'Compare', sections: ['compare'] },
  { label: 'Resources', sections: ['resources'] },
  { label: 'Company', sections: ['company', 'legal'] },
];

export function SiteFooter() {
  return (
    <footer className="mt-24 border-t bg-[var(--surface-sunken)]">
      <div className="container-site grid gap-12 py-14 md:grid-cols-[1.2fr_2fr]">
        <div className="flex flex-col gap-4">
          <img
            alt="Logbird · لوغبيرد"
            className="theme-light h-9 w-auto self-start"
            height="36"
            src="/brand/logbird-wordmark-bilingual-light.svg"
            width="220"
          />
          <img
            alt="Logbird · لوغبيرد"
            className="theme-dark h-9 w-auto self-start"
            height="36"
            src="/brand/logbird-wordmark-bilingual-dark.svg"
            width="220"
          />
          <p className="max-w-xs text-muted-foreground text-sm leading-relaxed">
            Retrace every step. <span lang="ar">تتبّع كل خطوة.</span>
            <br />
            The open-source audit log for your product.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-8 sm:grid-cols-3 lg:grid-cols-5">
          {footerGroups.map((group) => {
            const pages = siteMap.filter((page) => page.inFooter && group.sections.includes(page.section));
            return (
              <section key={group.label}>
                <h2 className="font-medium text-sm">{group.label}</h2>
                <ul className="mt-3 flex flex-col">
                  {pages.map((page) => (
                    <li key={page.path}>
                      <Link className="inline-flex min-h-9 items-center text-muted-foreground text-sm hover:text-foreground" to={page.path}>
                        {page.footerTitle ?? page.title}
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      </div>
      <div className="container-site flex flex-col gap-2 border-t py-6 text-muted-foreground text-sm sm:flex-row sm:items-center sm:justify-between">
        <p>© 2026 Joodlab. Logbird is MIT-licensed.</p>
        <p>
          {GITHUB_PUBLIC ? (
            <a className="hover:text-foreground" href={GITHUB_URL}>
              Source on GitHub
            </a>
          ) : (
            'Source on GitHub — coming soon.'
          )}
        </p>
      </div>
    </footer>
  );
}
