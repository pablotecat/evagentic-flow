import type { Execution } from '../api/types';
import type { Route } from '../router/hash';
import { linkClass } from '../lib/ui';
import type { HealthState } from '../hooks/useHealth';
import { HealthIndicator } from './HealthIndicator';
import { HistoryList } from './HistoryList';
import { ThemeSwitcher } from './ThemeSwitcher';

type Props = {
  open: boolean;
  route: Route;
  health: HealthState;
  executions: Execution[];
  selectedId: string | null;
  onNavigate: () => void;
};

export function Sidebar({ open, route, health, executions, selectedId, onNavigate }: Props) {
  return (
    <aside
      className={`fixed inset-y-0 left-0 z-40 flex w-72 flex-col gap-4 overflow-y-auto border-r border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900 lg:translate-x-0 ${open ? '' : 'max-lg:hidden'}`}
    >
      <div className="flex flex-col gap-3">
        <h1 className="px-1 text-base font-semibold tracking-tight text-slate-900 dark:text-slate-50">
          Flujo en Proyecto
        </h1>
        <ThemeSwitcher />
        <HealthIndicator state={health} />
      </div>
      <nav aria-label="Navegación principal" className="flex gap-2">
        <a href="#/" onClick={onNavigate} aria-current={route.view === 'new' ? 'page' : undefined}
          className={linkClass(route.view === 'new')}>
          Nuevo encargo
        </a>
        <a href="#/rubrics" onClick={onNavigate} aria-current={route.view === 'rubrics' ? 'page' : undefined}
          className={linkClass(route.view === 'rubrics')}>
          Rúbricas
        </a>
      </nav>
      <HistoryList executions={executions} selectedId={selectedId} onSelect={onNavigate} />
    </aside>
  );
}
