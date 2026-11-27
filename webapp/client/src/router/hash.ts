import { useSyncExternalStore } from 'react';

export const EXECUTION_TABS = ['conversation', 'deliverables', 'trace', 'evaluation'] as const;

export type ExecutionTab = typeof EXECUTION_TABS[number];

export type Route =
  | { view: 'new' }
  | { view: 'rubrics' }
  | { view: 'execution'; id: string; tab: ExecutionTab; session: string | null };

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, '');
  const [path, query = ''] = raw.split('?');
  const segments = path.split('/').filter(Boolean);
  if (segments[0] === 'rubrics') return { view: 'rubrics' };
  if (segments[0] === 'executions' && typeof segments[1] === 'string' && segments[1]) {
    const tab = EXECUTION_TABS.find(candidate => candidate === segments[2]) ?? 'conversation';
    return {
      view: 'execution',
      id: decodeURIComponent(segments[1]),
      tab,
      session: new URLSearchParams(query).get('session'),
    };
  }
  return { view: 'new' };
}

export function routeToHash(route: Route): string {
  if (route.view === 'rubrics') return '#/rubrics';
  if (route.view === 'new') return '#/';
  const query = route.session ? `?session=${encodeURIComponent(route.session)}` : '';
  return `#/executions/${encodeURIComponent(route.id)}/${route.tab}${query}`;
}

let cachedHash = '';
let cachedRoute: Route = { view: 'new' };

const currentRoute = (): Route => {
  if (window.location.hash !== cachedHash) {
    cachedHash = window.location.hash;
    cachedRoute = parseHash(cachedHash);
  }
  return cachedRoute;
};

const subscribeHash = (onChange: () => void) => {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
};

export function useRoute(): Route {
  return useSyncExternalStore(subscribeHash, currentRoute);
}

export function navigate(route: Route) {
  const next = routeToHash(route);
  if (window.location.hash !== next) window.location.hash = next;
}
