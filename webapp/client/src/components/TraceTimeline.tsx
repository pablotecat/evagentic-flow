import type { ExecutionInterval, ExternalWait, TraceResponse } from '../api/types';
import { sessionLabel } from '../lib/labels';
import { durationOrOpen, evidenceText, intervalStateLabel, isoOrUnobserved, waitKindOrUnknown, waitStateLabel } from '../lib/trace';
import { noticeClass } from '../lib/ui';

type Props = {
  trace: TraceResponse;
  rootSessionID: string | null;
};

const MARKS = [0, 0.25, 0.5, 0.75, 1];

const tooltipClass = 'pointer-events-none absolute left-1/2 top-full z-30 mt-1 hidden w-max max-w-[18rem] -translate-x-1/2 rounded-lg border border-slate-300 bg-white p-2 text-left text-[11px] leading-relaxed text-slate-700 shadow-lg group-hover:block group-focus:block dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200';

const barClass = 'group absolute inset-y-0 cursor-help outline-none focus-visible:ring-2 focus-visible:ring-sky-500';

const intervalBar = (open: boolean): string => (open
  ? 'block h-full w-full rounded border border-dashed border-sky-600 bg-sky-500/30 dark:border-sky-400'
  : 'block h-full w-full rounded bg-sky-500 dark:bg-sky-400');

const waitBar = (open: boolean): string => (open
  ? 'block h-full w-full rounded border border-dashed border-amber-600 bg-amber-500/30 dark:border-amber-400'
  : 'block h-full w-full rounded bg-amber-500 dark:bg-amber-400');

export function TraceTimeline({ trace, rootSessionID }: Props) {
  const intervals = trace.timeline.intervals ?? [];
  const waits = trace.timeline.waits ?? [];
  const sessionIDs: string[] = [];
  for (const item of [...intervals, ...waits]) {
    if (!sessionIDs.includes(item.sessionID)) sessionIDs.push(item.sessionID);
  }
  const bounds = [
    ...intervals.flatMap(interval => [interval.startedAt, interval.endedAt]),
    ...waits.flatMap(wait => [wait.startedAt, wait.endedAt]),
  ].filter((value): value is number => value !== null);
  const first = bounds.length ? Math.min(...bounds) : 0;
  const last = bounds.length ? Math.max(...bounds) : first + 1;
  const span = Math.max(last - first, 1);
  const percent = (value: number): number => Math.min(Math.max((value - first) / span, 0), 1) * 100;
  const sessionIntervals = (sessionID: string): ExecutionInterval[] =>
    intervals.filter(interval => interval.sessionID === sessionID);
  const sessionWaits = (sessionID: string): ExternalWait[] => waits.filter(wait => wait.sessionID === sessionID);
  const renderInterval = (interval: ExecutionInterval, index: number) => {
    if (interval.startedAt === null) return null;
    const open = interval.endedAt === null;
    const left = percent(interval.startedAt);
    const width = open
      ? Math.max(100 - left, 0.75)
      : Math.max((percent(interval.endedAt as number) - left), 0.4);
    const description = `Intervalo ${intervalStateLabel(interval.state)}: inicio ${isoOrUnobserved(interval.startedAt)}, fin ${isoOrUnobserved(interval.endedAt)}`;
    return (
      <span
        key={`interval-${index}`}
        tabIndex={0}
        data-kind={open ? 'interval-open' : 'interval'}
        aria-label={description}
        className={barClass}
        style={{ left: `${left.toFixed(3)}%`, width: `${width.toFixed(3)}%` }}
      >
        <span className={intervalBar(open)} />
        <span role="tooltip" className={tooltipClass}>
          <strong className="block font-semibold">Intervalo · {intervalStateLabel(interval.state)}</strong>
          <span className="block">Inicio: {isoOrUnobserved(interval.startedAt)}</span>
          <span className="block">Fin: {isoOrUnobserved(interval.endedAt)}</span>
          <span className="block">Duración: {durationOrOpen(interval.elapsedMs, open)}</span>
          <span className="block">Fuente: {interval.durationSource ?? 'desconocida'}</span>
          <span className="block">Evidencia: {evidenceText(interval.evidence ?? [])}</span>
          {!!interval.omissions?.length && (
            <span className="block">Omisiones: {interval.omissions.join(', ')}</span>
          )}
        </span>
      </span>
    );
  };
  const renderWait = (wait: ExternalWait, index: number) => {
    if (wait.startedAt === null) return null;
    const open = wait.endedAt === null;
    const left = percent(wait.startedAt);
    const width = open
      ? Math.max(100 - left, 0.75)
      : Math.max(percent(wait.endedAt as number) - left, 0.4);
    const description = `Espera externa ${waitKindOrUnknown(wait.kind)}: inicio ${isoOrUnobserved(wait.startedAt)}, fin ${isoOrUnobserved(wait.endedAt)}`;
    return (
      <span
        key={`wait-${index}`}
        tabIndex={0}
        data-kind={open ? 'wait-open' : 'wait'}
        aria-label={description}
        className={barClass}
        style={{ left: `${left.toFixed(3)}%`, width: `${width.toFixed(3)}%` }}
      >
        <span className={waitBar(open)} />
        <span role="tooltip" className={tooltipClass}>
          <strong className="block font-semibold">Espera externa · {waitKindOrUnknown(wait.kind)}</strong>
          <span className="block">Solicitud: {wait.requestID ?? 'desconocida'}</span>
          <span className="block">Estado: {waitStateLabel(wait.state)}</span>
          <span className="block">Inicio: {isoOrUnobserved(wait.startedAt)}</span>
          <span className="block">Fin: {isoOrUnobserved(wait.endedAt)}</span>
          <span className="block">Duración: {durationOrOpen(wait.elapsedMs, open)}</span>
          <span className="block">Fuente: {wait.durationSource ?? 'desconocida'}</span>
          <span className="block">Evidencia: {evidenceText(wait.evidence ?? [])}</span>
          {!!wait.omissions?.length && (
            <span className="block">Omisiones: {wait.omissions.join(', ')}</span>
          )}
        </span>
      </span>
    );
  };
  return (
    <section aria-label="Línea temporal" className="space-y-3">
      <h4 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Línea temporal</h4>
      <p className={noticeClass}>
        Las ramas concurrentes pueden solaparse, no se suman en una duración total y no implican un orden causal
        global entre diarios. Las posiciones usan el reloj público del runtime, no una cronología causal.
      </p>
      {sessionIDs.length ? (
        <>
          <ul
            aria-label="Leyenda de la línea temporal"
            className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-500 dark:text-slate-400"
          >
            <li className="flex items-center gap-1.5">
              <span className="h-2 w-4 rounded bg-sky-500 dark:bg-sky-400" aria-hidden="true" />
              Intervalo concluido
            </li>
            <li className="flex items-center gap-1.5">
              <span className="h-2 w-4 rounded border border-dashed border-sky-600 bg-sky-500/30 dark:border-sky-400" aria-hidden="true" />
              Intervalo abierto (sin cierre observado)
            </li>
            <li className="flex items-center gap-1.5">
              <span className="h-2 w-4 rounded bg-amber-500 dark:bg-amber-400" aria-hidden="true" />
              Espera externa
            </li>
          </ul>
          <div
            data-timeline-scale
            aria-label="Escala relativa del reloj público del runtime"
            className="relative h-5 w-full border-b border-slate-200 dark:border-slate-700"
          >
            {MARKS.map(fraction => (
              <span
                key={fraction}
                className="absolute top-0 -translate-x-1/2 text-[10px] text-slate-400 dark:text-slate-500"
                style={{ left: `${fraction * 100}%` }}
              >
                {Math.round(fraction * span)} ms
              </span>
            ))}
          </div>
          <ul aria-label="Intervalos y esperas por sesión" className="space-y-4">
            {sessionIDs.map(sessionID => {
              const own = sessionIntervals(sessionID);
              const ownWaits = sessionWaits(sessionID);
              const withoutStart = own.filter(interval => interval.startedAt === null).length;
              return (
                <li key={sessionID} data-timeline-session={sessionID} className="space-y-1">
                  <h5 className="text-xs font-semibold text-slate-600 dark:text-slate-300">
                    {sessionLabel({ sessionID: rootSessionID ?? '' }, sessionID)}
                  </h5>
                  <div className="space-y-1">
                    <div className="relative h-3 rounded bg-slate-100 dark:bg-slate-800">
                      {own.map(renderInterval)}
                    </div>
                    {ownWaits.length > 0 && (
                      <div className="relative h-2 rounded bg-slate-100 dark:bg-slate-800">
                        {ownWaits.map(renderWait)}
                      </div>
                    )}
                  </div>
                  {withoutStart > 0 && (
                    <p className={noticeClass}>
                      {withoutStart} intervalo(s) de esta sesión sin inicio observado: no se representa ninguna
                      posición deducida.
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <p className={noticeClass}>Sin intervalos ni esperas observados en el alcance actual de la evidencia.</p>
      )}
    </section>
  );
}
