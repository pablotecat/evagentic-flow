import { useSyncExternalStore } from 'react';

export type ThemePreference = 'claro' | 'oscuro' | 'sistema';

const STORAGE_KEY = 'flujo-en-proyecto-tema';

const listeners = new Set<() => void>();

const mediaQuery = typeof window !== 'undefined'
  ? window.matchMedia('(prefers-color-scheme: dark)') : null;

function readStored(): ThemePreference {
  const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
  return stored === 'claro' || stored === 'oscuro' || stored === 'sistema' ? stored : 'sistema';
}

let preference: ThemePreference = readStored();

function resolvedIsDark(): boolean {
  return preference === 'oscuro' || (preference === 'sistema' && (mediaQuery?.matches ?? false));
}

function applyTheme() {
  document.documentElement.classList.toggle('dark', resolvedIsDark());
}

function publish() {
  for (const listener of listeners) listener();
}

export function setThemePreference(next: ThemePreference) {
  preference = next;
  try { localStorage.setItem(STORAGE_KEY, next); } catch { }
  applyTheme();
  publish();
}

const subscribeTheme = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

const currentPreference = () => preference;

export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribeTheme, currentPreference);
}

if (mediaQuery) {
  mediaQuery.addEventListener('change', () => {
    applyTheme();
    publish();
  });
}
applyTheme();
