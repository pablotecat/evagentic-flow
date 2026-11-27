import { useState } from 'react';
import { Menu } from 'lucide-react';
import { useHealth } from './hooks/useHealth';
import { useExecutions } from './hooks/useExecutions';
import { useRoute } from './router/hash';
import { Sidebar } from './components/Sidebar';
import { Composer } from './components/Composer';
import { ExecutionView } from './components/ExecutionView';
import { RubricsView } from './components/RubricsView';

export default function App() {
  const route = useRoute();
  const health = useHealth();
  const executions = useExecutions();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const selectedId = route.view === 'execution' ? route.id : null;
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      {drawerOpen && (
        <button
          type="button"
          aria-label="Cerrar menú"
          onClick={() => setDrawerOpen(false)}
          className="fixed inset-0 z-30 bg-slate-950/40 lg:hidden"
        />
      )}
      <Sidebar
        open={drawerOpen}
        route={route}
        health={health}
        executions={executions}
        selectedId={selectedId}
        onNavigate={() => setDrawerOpen(false)}
      />
      <div className="lg:pl-72">
        <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-slate-200 bg-slate-50/90 px-4 py-2.5 backdrop-blur lg:hidden dark:border-slate-800 dark:bg-slate-950/90">
          <button
            type="button"
            aria-label="Abrir menú"
            onClick={() => setDrawerOpen(true)}
            className="rounded-lg p-1.5 text-slate-600 transition-colors hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            <Menu className="size-5" aria-hidden="true" />
          </button>
          <span className="text-sm font-medium">Flujo en Proyecto</span>
        </header>
        <main className="mx-auto max-w-3xl px-4 pb-16 sm:px-6">
          {route.view === 'new' && <Composer indexStatus={health.health?.index?.status ?? null} />}
          {route.view === 'rubrics' && <RubricsView />}
          {route.view === 'execution'
            && <ExecutionView key={route.id} id={route.id} tab={route.tab} session={route.session}
              engineReachable={health.health?.engine?.reachable ?? null} />}
        </main>
      </div>
    </div>
  );
}
