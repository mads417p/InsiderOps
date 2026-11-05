'use client';

import { useEffect, useRef } from 'react';
import { ArrowLeft, SunMoon, X, type LucideIcon } from 'lucide-react';
import { NoEdgeBanner } from '@/components/NoEdgeBanner';
import { btn } from '@/components/ui';

export interface NavTab<T extends string> {
  id: T;
  label: string;
  icon: LucideIcon;
  count?: number;
}

const THEME_KEY = 'insiderops_theme';

/**
 * Skifter mellem lys og mørk. Uden valg følger siden systemet (prefers-color-scheme).
 * ponytail: valget sættes ved mount, så et valg modsat systemet kan blinke kort ved indlæsning. Et script før
 * første paint giver en React-advarsel, og en cookie i layoutet blokerer prerendering (cacheComponents).
 */
function ThemeToggle() {
  useEffect(() => {
    try {
      const t = localStorage.getItem(THEME_KEY);
      if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
    } catch {}
  }, []);
  const toggle = () => {
    const root = document.documentElement;
    const current = root.dataset.theme ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {}
  };
  return (
    <button type="button" onClick={toggle} className={btn.quiet}>
      <SunMoon className="size-4" aria-hidden />
      Lys / mørk
    </button>
  );
}

/**
 * Desktop: smal venstre-navigation, listen i midten og sagen i et højre-panel.
 * Mobil: faner øverst og sagen som fuldskærmsark.
 */
export function AppShell<T extends string>({
  tabs,
  active,
  onTab,
  footer,
  caseOpen,
  caseTitle,
  onCloseCase,
  caseContent,
  children,
}: {
  tabs: NavTab<T>[];
  active: T;
  onTab: (t: T) => void;
  footer?: React.ReactNode;
  caseOpen: boolean;
  caseTitle: string;
  onCloseCase: () => void;
  caseContent: React.ReactNode;
  children: React.ReactNode;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  // Åben sag: fokus til sagens overskrift. Lukket: fokus tilbage til det, der åbnede den.
  useEffect(() => {
    if (caseOpen) {
      returnFocus.current ??= document.activeElement as HTMLElement | null;
      headingRef.current?.focus({ preventScroll: true });
    } else {
      returnFocus.current?.focus({ preventScroll: true });
      returnFocus.current = null;
    }
  }, [caseOpen, caseTitle]);

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[184px_minmax(0,1fr)_auto]">
      {/* Desktop-navigation */}
      <nav aria-label="Hovednavigation" className="hidden lg:flex sticky top-0 h-screen flex-col border-r border-line bg-surface px-3 py-5">
        <div className="px-2 pb-6 font-cond text-xl font-semibold text-ink">InsiderOps</div>
        <ul className="space-y-0.5">
          {tabs.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => onTab(t.id)}
                aria-current={active === t.id ? 'page' : undefined}
                className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-sm ${
                  active === t.id ? 'bg-paper font-medium text-ink ring-1 ring-line' : 'text-graphite hover:text-ink'
                }`}
              >
                <t.icon className={`size-4 ${active === t.id ? 'text-accent' : ''}`} aria-hidden />
                <span className="flex-1 text-left">{t.label}</span>
                {t.count !== undefined && <span className="font-mono text-xs text-graphite">{t.count}</span>}
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-auto space-y-3">
          <ThemeToggle />
          {footer && <div className="px-2 text-xs leading-relaxed text-graphite">{footer}</div>}
        </div>
      </nav>

      {/* Mobil: topbar + faner */}
      <div className="lg:hidden sticky top-0 z-30 border-b border-line bg-surface">
        <div className="flex items-center justify-between px-4 pt-3">
          <span className="font-cond text-lg font-semibold">InsiderOps</span>
          <ThemeToggle />
        </div>
        <div role="tablist" aria-label="Faner" className="flex gap-1 overflow-x-auto px-2 pt-1">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active === t.id}
              onClick={() => onTab(t.id)}
              className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm ${
                active === t.id ? 'border-accent font-medium text-ink' : 'border-transparent text-graphite'
              }`}
            >
              {t.label}
              {t.count !== undefined && <span className="ml-1 font-mono text-xs text-graphite">{t.count}</span>}
            </button>
          ))}
        </div>
      </div>

      <main className="min-w-0 px-4 py-5 lg:px-8 lg:py-6">
        <NoEdgeBanner />
        <div className="mt-5">{children}</div>
        {footer && <footer className="mt-10 border-t border-line pt-3 text-xs leading-relaxed text-graphite lg:hidden">{footer}</footer>}
      </main>

      {/* Sagen: højre-panel på desktop, fuldskærmsark på mobil. */}
      {caseOpen && (
        <aside
          id="case-panel"
          aria-labelledby="case-title"
          onKeyDown={(e) => e.key === 'Escape' && onCloseCase()}
          className="fixed inset-0 z-50 overflow-y-auto bg-paper lg:sticky lg:inset-auto lg:top-0 lg:z-auto lg:h-screen lg:w-[440px] xl:w-[540px] lg:border-l lg:border-line"
        >
          <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-paper px-4 py-3 lg:px-6">
            <button type="button" onClick={onCloseCase} className={`${btn.quiet} -ml-2 lg:hidden`}>
              <ArrowLeft className="size-4" aria-hidden />
              Tilbage
            </button>
            <h2 id="case-title" ref={headingRef} tabIndex={-1} className="flex-1 text-sm text-graphite outline-none">
              Sag · <span className="font-cond text-base font-semibold text-ink">{caseTitle}</span>
            </h2>
            <span className="hidden lg:block">
              <button type="button" onClick={onCloseCase} className={btn.quiet} aria-label="Luk sagen">
                <X className="size-4" aria-hidden />
                Luk
              </button>
            </span>
          </div>
          <div className="space-y-4 px-4 py-5 lg:px-6">{caseContent}</div>
          <div className="px-4 pb-6 lg:px-6">
            <NoEdgeBanner compact />
          </div>
        </aside>
      )}
    </div>
  );
}
