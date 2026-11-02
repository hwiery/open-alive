import { useEffect, useState } from 'react';
import { getSettings, subscribeSettings, type AppearanceMode } from './settings';

/**
 * Stamps the resolved colour mode on <html data-theme>, which swaps the CSS token
 * set in index.css. 'system' tracks prefers-color-scheme live.
 */

export type ResolvedTheme = 'dark' | 'light';

export function resolveAppearance(mode: AppearanceMode, systemPrefersLight: boolean): ResolvedTheme {
  if (mode === 'system') return systemPrefersLight ? 'light' : 'dark';
  return mode;
}

export function installAppearance(root: HTMLElement = document.documentElement): () => void {
  const media = typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: light)')
    : null;
  const apply = () => {
    root.dataset.theme = resolveAppearance(getSettings().appearance.mode, media?.matches ?? false);
  };
  apply();
  const unsubscribe = subscribeSettings(apply);
  media?.addEventListener('change', apply);
  return () => {
    unsubscribe();
    media?.removeEventListener('change', apply);
  };
}

/** Theme currently stamped on <html>. Falls back to dark before installAppearance runs. */
export function getAppTheme(root: HTMLElement = document.documentElement): ResolvedTheme {
  return root.dataset.theme === 'light' ? 'light' : 'dark';
}

/**
 * Notify on every change of the resolved theme, including OS-driven flips in
 * 'system' mode that never touch the settings store. Watches <html data-theme>
 * so it sees exactly what the CSS sees.
 */
export function subscribeAppTheme(fn: (theme: ResolvedTheme) => void, root: HTMLElement = document.documentElement): () => void {
  let last = getAppTheme(root);
  const observer = new MutationObserver(() => {
    const next = getAppTheme(root);
    if (next === last) return;
    last = next;
    fn(next);
  });
  observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}

export function useAppTheme(): ResolvedTheme {
  const [theme, setTheme] = useState<ResolvedTheme>(() => getAppTheme());
  useEffect(() => {
    setTheme(getAppTheme());
    return subscribeAppTheme(setTheme);
  }, []);
  return theme;
}
