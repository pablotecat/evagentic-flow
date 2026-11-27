import { useExecutionDetail } from '../hooks/useExecutionDetail';
import { EXECUTION_TABS, navigate, type ExecutionTab } from '../router/hash';
import { StatusBadge } from './StatusBadge';
import { chipClass, noticeClass } from '../lib/ui';

const TAB_LABELS: Record<ExecutionTab, string> = {
  conversation: 'Conversación',
  deliverables: 'Entregables',
  trace: 'Traza',
  evaluation: 'Evaluación',
};

const TAB_PLACEHOLDERS: Record<ExecutionTab, string> = {
  conversation: 'Sin contenido observado todavía en la captura.',
  deliverables: 'Los entregables conservados en la captura se mostrarán en una vista dedicada.',
  trace: 'La traza y el diagnóstico técnico se mostrarán en una vista dedicada.',
  evaluation: 'Sin evaluación en este corte: el desenlace técnico no equivale a una aceptación.',
};

type Props = {
  id: string;
  tab: ExecutionTab;
  session: string | null;
};

export function ExecutionView({ id, tab, session }: Props) {
  const { detail, missing } = useExecutionDetail(id);
  if (missing && detail === null) {
    return (
      <section aria-label={`Ejecución ${id}`} className="pt-10 lg:pt-20">
        <h2 className="text-2xl font-semibold tracking-tight">Ejecución {id.slice(0, 8)}</h2>
        <p className={`${noticeClass} mt-4`}>No se pudo consultar la ejecución: puede que no exista en el índice persistente.</p>
      </section>
    );
  }
  if (detail === null) {
    return (
      <section aria-label={`Ejecución ${id}`} className="pt-10 lg:pt-20">
        <h2 className="text-2xl font-semibold tracking-tight">Ejecución {id.slice(0, 8)}</h2>
        <p className={`${noticeClass} mt-4`}>Consultando la evidencia persistida…</p>
      </section>
    );
  }
  const execution = detail.execution;
  const knownModel = execution.knownModel?.value ?? null;
  const selectTab = (next: ExecutionTab) =>
    navigate({ view: 'execution', id, tab: next, session });
  return (
    <section aria-label={`Ejecución ${execution.id}`} className="pt-6 lg:pt-10">
      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-2xl font-semibold tracking-tight">Ejecución {execution.id.slice(0, 8)}</h2>
          <StatusBadge status={execution.status} />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {execution.requestedCommand && <span className={chipClass}>Comando: {execution.requestedCommand.name}</span>}
          {execution.knownAgent ? (
            <span className={chipClass}>
              Agente: {execution.knownAgent}
              {execution.requestedAgent && execution.requestedAgent !== execution.knownAgent
                ? ` (solicitado: ${execution.requestedAgent})` : ''}
            </span>
          ) : execution.requestedAgent ? (
            <span className={chipClass}>Agente: {execution.requestedAgent} (solicitado, sin confirmar)</span>
          ) : null}
          {knownModel ? (
            <span className={chipClass}>
              Modelo: <span className="font-mono">{knownModel}</span>
              {execution.requestedModel && execution.requestedModel !== knownModel
                ? <> (solicitado: <span className="font-mono">{execution.requestedModel}</span>)</> : null}
            </span>
          ) : execution.requestedModel ? (
            <span className={chipClass}>
              Modelo: <span className="font-mono">{execution.requestedModel}</span> (solicitado, sin confirmar)
            </span>
          ) : null}
          {execution.sessionID && (
            <span className={chipClass}>Sesión raíz: <span className="font-mono">{execution.sessionID}</span></span>
          )}
          {session && (
            <span className={chipClass} data-subexecution={session}>
              Subejecución: <span className="font-mono">{session}</span>
            </span>
          )}
        </div>
      </header>
      <div role="tablist" aria-label="Secciones de la ejecución" className="mt-6 flex gap-1 border-b border-slate-200 dark:border-slate-700">
        {EXECUTION_TABS.map(candidate => {
          const selected = candidate === tab;
          return (
            <button
              key={candidate}
              type="button"
              role="tab"
              id={`tab-${candidate}`}
              aria-selected={selected}
              aria-controls={`panel-${candidate}`}
              onClick={() => selectTab(candidate)}
              className={`-mb-px rounded-t-lg border-b-2 px-3 py-2 text-sm font-medium transition-colors ${selected
                ? 'border-sky-500 text-sky-600 dark:border-sky-400 dark:text-sky-300'
                : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'}`}
            >
              {TAB_LABELS[candidate]}
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id={`panel-${tab}`}
        aria-labelledby={`tab-${tab}`}
        className="py-6 text-sm leading-relaxed"
      >
        {tab === 'conversation' ? <Conversation detail={detail} /> : <p className={noticeClass}>{TAB_PLACEHOLDERS[tab]}</p>}
      </div>
    </section>
  );
}

function Conversation({ detail }: { detail: NonNullable<ReturnType<typeof useExecutionDetail>['detail']> }) {
  const entries = detail.conversation?.entries ?? [];
  const responses = detail.conversation?.responses ?? [];
  return (
    <div className="space-y-4">
      {entries.map((entry, index) => (
        <article key={`entry-${index}`} className="rounded-xl bg-slate-100 p-4 dark:bg-slate-800/60">
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Encargo</h3>
          <p className="whitespace-pre-wrap break-words">{entry.text}</p>
        </article>
      ))}
      {responses.map((response, index) => (
        <article key={`response-${index}`} className="rounded-xl bg-white p-4 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-700">
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Respuesta</h3>
          <p className="whitespace-pre-wrap break-words">{response.text}</p>
        </article>
      ))}
      {!entries.length && !responses.length && <p className={noticeClass}>{TAB_PLACEHOLDERS.conversation}</p>}
    </div>
  );
}
