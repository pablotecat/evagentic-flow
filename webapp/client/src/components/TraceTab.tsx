import type { TraceBody, TraceTree } from '../api/types';
import { noticeClass } from '../lib/ui';
import { scopeSummary } from './TraceScopeBar';
import { TraceTree as TraceTreeView } from './TraceTree';
import { TraceTimeline } from './TraceTimeline';

export const TRACE_DIMENSIONS = [
  { id: 'tree', label: 'Árbol y línea temporal' },
  { id: 'tools', label: 'Herramientas e intentos' },
  { id: 'metrics', label: 'Métricas' },
  { id: 'skills-coverage', label: 'Skills y cobertura' },
] as const;

export type TraceDimension = typeof TRACE_DIMENSIONS[number]['id'];

type Props = {
  session: string | null;
  trace: TraceBody | null;
  rootTree: TraceTree | null;
  rootReason: string | null;
  rootSessionID: string | null;
  dimension: TraceDimension;
  onDimensionChange: (dimension: TraceDimension) => void;
  onSelectSession: (session: string | null) => void;
};

const PLACEHOLDER_TEXT: Record<Exclude<TraceDimension, 'tree'>, string> = {
  tools: 'Las llamadas de herramienta con identidad, entrada autorizada, desenlace y evidencia se mostrarán aquí sobre la misma consulta de traza.',
  metrics: 'Los pasos de modelo y las mediciones con valor, fuente y alcance se mostrarán aquí sobre la misma consulta de traza.',
  'skills-coverage': 'Las skills observadas, las definiciones y la cobertura de captura se mostrarán aquí sobre la misma consulta de traza.',
};

export function TraceTab({
  session,
  trace,
  rootTree,
  rootReason,
  rootSessionID,
  dimension,
  onDimensionChange,
  onSelectSession,
}: Props) {
  const knownCount = rootTree?.sessionIDs.length ?? null;
  const scopeText = scopeSummary(session, rootSessionID, knownCount);
  return (
    <div>
      <div
        role="tablist"
        aria-label="Dimensiones diagnósticas de la traza"
        className="flex flex-wrap gap-1 border-b border-slate-200 dark:border-slate-700"
      >
        {TRACE_DIMENSIONS.map(candidate => {
          const selected = candidate.id === dimension;
          return (
            <button
              key={candidate.id}
              type="button"
              role="tab"
              id={`traza-tab-${candidate.id}`}
              aria-selected={selected}
              aria-controls={`traza-panel-${candidate.id}`}
              onClick={() => onDimensionChange(candidate.id)}
              className={`-mb-px rounded-t-lg border-b-2 px-2.5 py-1.5 text-xs font-medium transition-colors ${selected
                ? 'border-sky-500 text-sky-600 dark:border-sky-400 dark:text-sky-300'
                : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'}`}
            >
              {candidate.label}
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id={`traza-panel-${dimension}`}
        aria-labelledby={`traza-tab-${dimension}`}
        className="space-y-6 py-4"
      >
        {dimension === 'tree' ? (
          <>
            {rootTree !== null ? (
              <TraceTreeView
                tree={rootTree}
                rootSessionID={rootSessionID}
                selectedSession={session}
                onSelectSession={onSelectSession}
              />
            ) : (
              <section aria-label="Árbol de subejecuciones" className="space-y-1">
                <h4 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Árbol de subejecuciones</h4>
                <p className={noticeClass}>
                  {rootReason !== null
                    ? `El árbol completo de la ejecución no está consultable (${rootReason}); no se deducen relaciones.`
                    : 'Consultando el árbol de subejecuciones…'}
                </p>
              </section>
            )}
            {trace === null ? (
              <section aria-label="Línea temporal" className="space-y-1">
                <h4 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Línea temporal</h4>
                <p className={noticeClass}>Consultando la traza de este alcance…</p>
              </section>
            ) : !trace.readable ? (
              <section aria-label="Línea temporal" className="space-y-1">
                <h4 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Línea temporal</h4>
                <p className={noticeClass}>
                  La traza no está consultable ({trace.reason ?? 'desconocido'}); no se reconstruye contenido no
                  capturado.
                </p>
              </section>
            ) : (
              <TraceTimeline trace={trace} rootSessionID={rootSessionID} />
            )}
          </>
        ) : (
          <div className="space-y-2">
            <p className="text-sm leading-relaxed text-slate-700 dark:text-slate-300">{PLACEHOLDER_TEXT[dimension]}</p>
            <p className={noticeClass}>Alcance activo: {scopeText}.</p>
          </div>
        )}
      </div>
    </div>
  );
}
