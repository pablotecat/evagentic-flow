import { useState } from 'react';
import type { Execution, ExecutionStatus } from '../api/types';
import { navigate } from '../router/hash';
import { STATUS_LABELS, STATUS_ORDER, relativeTime } from '../lib/format';
import { StatusBadge } from './StatusBadge';

export function executionTitle(execution: Execution): string {
  if (execution.requestedCommand?.name) return execution.requestedCommand.name;
  if (execution.knownAgent) return execution.knownAgent;
  if (execution.requestedAgent) return `${execution.requestedAgent} (solicitado)`;
  return `Ejecución ${execution.id.slice(0, 8)}`;
}

export function executionModel(execution: Execution): string | null {
  if (execution.knownModel?.value) return execution.knownModel.value;
  if (execution.requestedModel) return `${execution.requestedModel} (solicitado)`;
  return null;
}

const matchesFilter = (execution: Execution, text: string, status: 'all' | ExecutionStatus): boolean => {
  if (status !== 'all' && execution.status !== status) return false;
  if (!text) return true;
  const haystack = [execution.id, execution.requestedCommand?.name, execution.knownAgent,
    execution.requestedAgent, execution.knownModel?.value, execution.requestedModel]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map(value => value.toLowerCase());
  return haystack.some(value => value.includes(text.toLowerCase()));
};

type Props = {
  executions: Execution[];
  selectedId: string | null;
  onSelect?: () => void;
};

export function HistoryList({ executions, selectedId, onSelect }: Props) {
  const [text, setText] = useState('');
  const [status, setStatus] = useState<'all' | ExecutionStatus>('all');
  const visible = executions.filter(execution => matchesFilter(execution, text.trim(), status));
  return (
    <section aria-label="Histórico de ejecuciones" className="flex min-h-0 flex-1 flex-col gap-2">
      <input
        type="search"
        aria-label="Filtrar ejecuciones"
        value={text}
        onChange={event => setText(event.target.value)}
        placeholder="Filtrar por identificador, agente, modelo o comando"
        className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900 placeholder:text-slate-400 focus:border-sky-500 focus:outline-none dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
      />
      <select
        aria-label="Filtrar por estado"
        value={status}
        onChange={event => setStatus(event.target.value as 'all' | ExecutionStatus)}
        className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900 focus:border-sky-500 focus:outline-none dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
      >
        <option value="all">Todos los estados</option>
        {STATUS_ORDER.map(value => <option key={value} value={value}>{STATUS_LABELS[value]}</option>)}
      </select>
      <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto">
        {visible.map(execution => (
          <li key={execution.id}>
            <button
              type="button"
              data-id={execution.id}
              aria-current={selectedId === execution.id ? 'true' : undefined}
              onClick={() => {
                navigate({ view: 'execution', id: execution.id, tab: 'conversation', session: null });
                onSelect?.();
              }}
              className={`flex w-full flex-col gap-1 rounded-xl border px-2.5 py-2 text-left transition-colors ${selectedId === execution.id
                ? 'border-sky-400 bg-sky-50 dark:border-sky-500 dark:bg-sky-950/50'
                : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800'}`}
            >
              <span className="flex items-center gap-2">
                <StatusBadge status={execution.status} />
                <span className="truncate text-xs font-medium text-slate-800 dark:text-slate-100">
                  {executionTitle(execution)}
                </span>
              </span>
              <span className="flex items-center justify-between gap-2 text-[11px] text-slate-500 dark:text-slate-400">
                <span className="truncate font-mono">{executionModel(execution) ?? 'modelo sin confirmar'}</span>
                <span className="shrink-0" data-testid="relative-time">{relativeTime(execution.createdAt)}</span>
              </span>
            </button>
          </li>
        ))}
        {!visible.length && (
          <li className="rounded-lg px-2 py-6 text-center text-xs text-slate-400">
            {executions.length ? 'Ninguna ejecución coincide con el filtro.' : 'Sin ejecuciones todavía.'}
          </li>
        )}
      </ul>
    </section>
  );
}
