import { useId } from 'react';
import type { ExecutionInterval, ExternalWait, TraceResponse } from '../api/types';
import { sessionLabel } from '../lib/labels';
import { durationOrOpen, evidenceText, intervalStateLabel, isoOrUnobserved, waitKindOrUnknown, waitStateLabel } from '../lib/trace';
import { noticeClass } from '../lib/ui';

type Props = {
  trace: TraceResponse;
  rootSessionID: string | null;
};

type TimelineBarProps = {
  tooltipId: string;
  kind: string;
  description: string;
  left: number;
  width: number;
  fillClass: string;
  title: string;
  lines: string[];
};

const MARKS = [0, 0.25, 0.5, 0.75, 1];
const MIN_CLOSED_WIDTH = 0.4;
const MIN_OPEN_WIDTH = 0.75;

const tooltipClass = 'pointer-events-none absolute left-1/2 top-full z-30 mt-1 hidden w-max max-w-[18rem] -translate-x-1/2 rounded-lg border border-slate-300 bg-white p-2 text-left text-[11px] leading-relaxed text-slate-700 shadow-lg group-hover:block group-focus:block dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200';

const barClass = 'group absolute inset-y-0 cursor-help outline-none focus-visible:ring-2 focus-visible:ring-sky-500';

const intervalVisual = (interval: ExecutionInterval, open: boolean): { kind: string; fillClass: string } => {
  if (open) {
    return {
      kind: 'interval-open',
      fillClass: 'block h-full w-full rounded border border-dashed border-sky-600 bg-sky-500/30 dark:border-sky-400',
    };
  }
  if (interval.state === 'failed' || interval.outcome === 'failed') {
    return {
      kind: 'interval-failed',
      fillClass: 'block h-full w-full rounded bg-rose-500 ring-1 ring-rose-700/40 dark:bg-rose-400 dark:ring-rose-200/40',
    };
  }
  if (interval.state === 'interrupted' || interval.outcome === 'interrupted') {
    return {
      kind: 'interval-interrupted',
      fillClass: 'block h-full w-full rounded border border-orange-700 bg-orange-500 dark:border-orange-300 dark:bg-orange-400',
    };
  }
  return {
    kind: 'interval',
    fillClass: 'block h-full w-full rounded bg-sky-500 dark:bg-sky-400',
  };
};

const waitVisual = (open: boolean): { kind: string; fillClass: string } => (open
  ? {
    kind: 'wait-open',
    fillClass: 'block h-full w-full rounded border border-dashed border-amber-600 bg-amber-500/30 dark:border-amber-400',
  }
  : {
    kind: 'wait',
    fillClass: 'block h-full w-full rounded bg-amber-500 dark:bg-amber-400',
  });

const barGeometry = (
  startedAt: number,
  endedAt: number | null,
  percent: (value: number) => number,
): { left: number; width: number } => {
  const rawLeft = percent(startedAt);
  const width = endedAt === null
    ? Math.min(Math.max(100 - rawLeft, MIN_OPEN_WIDTH), 100)
    : Math.min(Math.max(percent(endedAt) - rawLeft, MIN_CLOSED_WIDTH), 100);
  const left = Math.max(0, Math.min(rawLeft, 100 - width));
  return { left, width };
};

function TimelineBar({ tooltipId, kind, description, left, width, fillClass, title, lines }: TimelineBarProps) {
  return (
    <span
      role="img"
      tabIndex={0}
      data-kind={kind}
      aria-label={description}
      aria-describedby={tooltipId}
      className={barClass}
      style={{ left: `${left.toFixed(3)}%`, width: `${width.toFixed(3)}%` }}
    >
      <span className={fillClass} aria-hidden="true" />
      <span id={tooltipId} role="tooltip" className={tooltipClass}>
        <strong className="block font-semibold">{title}</strong>
        {lines.map((line, index) => (
          <span key={index} className="block">{line}</span>
        ))}
      </span>
    </span>
  );
}

const unplottedIntervalDetail = (interval: ExecutionInterval): string =>
  `Intervalo · ${intervalStateLabel(interval.state)} · fin: ${isoOrUnobserved(interval.endedAt)} · fuente: ${interval.durationSource ?? 'desconocida'}`;

const unplottedWaitDetail = (wait: ExternalWait): string =>
  `Espera externa · ${waitKindOrUnknown(wait.kind)} · solicitud: ${wait.requestID ?? 'desconocida'} · fin: ${isoOrUnobserved(wait.endedAt)} · fuente: ${wait.durationSource ?? 'desconocida'}`;

export function TraceTimeline({ trace, rootSessionID }: Props) {
  const idPrefix = useId();
  const intervals = trace.timeline.intervals ?? [];
  const waits = trace.timeline.waits ?? [];
  const sessionIDs: string[] = [];
  for (const item of [...intervals, ...waits]) {
    if (!sessionIDs.includes(item.sessionID)) sessionIDs.push(item.sessionID);
  }
  const plottedIntervals = intervals.filter(interval => interval.startedAt !== null);
  const plottedWaits = waits.filter(wait => wait.startedAt !== null);
  const bounds = [
    ...plottedIntervals.flatMap(interval => [interval.startedAt, interval.endedAt]),
    ...plottedWaits.flatMap(wait => [wait.startedAt, wait.endedAt]),
  ].filter((value): value is number => value !== null);
  const hasScale = bounds.length > 0;
  const first = hasScale ? Math.min(...bounds) : 0;
  const last = hasScale ? Math.max(...bounds) : 0;
  const rawSpan = last - first;
  const zeroSpan = hasScale && rawSpan === 0;
  const scaleMarks = zeroSpan ? [0] : MARKS;
  const percent = (value: number): number => {
    if (!hasScale || zeroSpan) return 0;
    return Math.min(Math.max((value - first) / rawSpan, 0), 1) * 100;
  };
  const sessionIntervals = (sessionID: string): ExecutionInterval[] =>
    intervals.filter(interval => interval.sessionID === sessionID);
  const sessionWaits = (sessionID: string): ExternalWait[] =>
    waits.filter(wait => wait.sessionID === sessionID);

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
              <span className="h-2 w-4 rounded bg-rose-500 ring-1 ring-rose-700/40 dark:bg-rose-400 dark:ring-rose-200/40" aria-hidden="true" />
              Intervalo fallido
            </li>
            <li className="flex items-center gap-1.5">
              <span className="h-2 w-4 rounded border border-orange-700 bg-orange-500 dark:border-orange-300 dark:bg-orange-400" aria-hidden="true" />
              Intervalo interrumpido
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
          {hasScale && (
            <div
              data-timeline-scale
              aria-label="Escala relativa del reloj público del runtime"
              className="relative h-5 w-full border-b border-slate-200 dark:border-slate-700"
            >
              {scaleMarks.map(fraction => (
                <span
                  key={fraction}
                  className={`absolute top-0 text-[10px] text-slate-400 dark:text-slate-500 ${fraction === 0 ? '' : fraction === 1 ? '-translate-x-full' : '-translate-x-1/2'}`}
                  style={{ left: `${fraction * 100}%` }}
                >
                  {Math.round(fraction * rawSpan)} ms
                </span>
              ))}
            </div>
          )}
          <ul aria-label="Intervalos y esperas por sesión" className="space-y-4">
            {sessionIDs.map((sessionID, sessionIndex) => {
              const own = sessionIntervals(sessionID);
              const ownWaits = sessionWaits(sessionID);
              const plottedOwn = own.filter(interval => interval.startedAt !== null);
              const plottedOwnWaits = ownWaits.filter(wait => wait.startedAt !== null);
              const unplottedOwn = own.filter(interval => interval.startedAt === null);
              const unplottedOwnWaits = ownWaits.filter(wait => wait.startedAt === null);
              return (
                <li key={sessionID} data-timeline-session={sessionID} className="space-y-1">
                  <h5 className="text-xs font-semibold text-slate-600 dark:text-slate-300">
                    {sessionLabel({ sessionID: rootSessionID ?? '' }, sessionID)}
                  </h5>
                  {(plottedOwn.length > 0 || plottedOwnWaits.length > 0) && (
                    <div className="space-y-1">
                      {plottedOwn.length > 0 && (
                        <div className="relative h-3 rounded bg-slate-100 dark:bg-slate-800">
                          {plottedOwn.map((interval, index) => {
                            const open = interval.endedAt === null;
                            const { left, width } = barGeometry(interval.startedAt as number, interval.endedAt, percent);
                            const visual = intervalVisual(interval, open);
                            const lines = [
                              `Inicio: ${isoOrUnobserved(interval.startedAt)}`,
                              `Fin: ${isoOrUnobserved(interval.endedAt)}`,
                              `Duración: ${durationOrOpen(interval.elapsedMs, open)}`,
                              `Fuente: ${interval.durationSource ?? 'desconocida'}`,
                              `Evidencia: ${evidenceText(interval.evidence ?? [])}`,
                              ...(interval.omissions?.length ? [`Omisiones: ${interval.omissions.join(', ')}`] : []),
                            ];
                            return (
                              <TimelineBar
                                key={`interval-${index}`}
                                tooltipId={`${idPrefix}-interval-${sessionIndex}-${index}`}
                                kind={visual.kind}
                                description={`Intervalo ${intervalStateLabel(interval.state)}: inicio ${isoOrUnobserved(interval.startedAt)}, fin ${isoOrUnobserved(interval.endedAt)}`}
                                left={left}
                                width={width}
                                fillClass={visual.fillClass}
                                title={`Intervalo · ${intervalStateLabel(interval.state)}`}
                                lines={lines}
                              />
                            );
                          })}
                        </div>
                      )}
                      {plottedOwnWaits.length > 0 && (
                        <div className="relative h-2 rounded bg-slate-100 dark:bg-slate-800">
                          {plottedOwnWaits.map((wait, index) => {
                            const open = wait.endedAt === null;
                            const { left, width } = barGeometry(wait.startedAt as number, wait.endedAt, percent);
                            const visual = waitVisual(open);
                            const lines = [
                              `Solicitud: ${wait.requestID ?? 'desconocida'}`,
                              `Estado: ${waitStateLabel(wait.state)}`,
                              `Inicio: ${isoOrUnobserved(wait.startedAt)}`,
                              `Fin: ${isoOrUnobserved(wait.endedAt)}`,
                              `Duración: ${durationOrOpen(wait.elapsedMs, open)}`,
                              `Fuente: ${wait.durationSource ?? 'desconocida'}`,
                              `Evidencia: ${evidenceText(wait.evidence ?? [])}`,
                              ...(wait.omissions?.length ? [`Omisiones: ${wait.omissions.join(', ')}`] : []),
                            ];
                            return (
                              <TimelineBar
                                key={`wait-${index}`}
                                tooltipId={`${idPrefix}-wait-${sessionIndex}-${index}`}
                                kind={visual.kind}
                                description={`Espera externa ${waitKindOrUnknown(wait.kind)}: inicio ${isoOrUnobserved(wait.startedAt)}, fin ${isoOrUnobserved(wait.endedAt)}`}
                                left={left}
                                width={width}
                                fillClass={visual.fillClass}
                                title={`Espera externa · ${waitKindOrUnknown(wait.kind)}`}
                                lines={lines}
                              />
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                  {(unplottedOwn.length > 0 || unplottedOwnWaits.length > 0) && (
                    <div data-timeline-unplotted={sessionID} className="space-y-0.5">
                      {unplottedOwn.length > 0 && (
                        <p className={noticeClass}>
                          {unplottedOwn.length} intervalo(s) de esta sesión sin inicio observado: no se representa ninguna
                          posición deducida.
                        </p>
                      )}
                      {unplottedOwnWaits.length > 0 && (
                        <p className={noticeClass}>
                          {unplottedOwnWaits.length} espera(s) externa(s) de esta sesión sin inicio observado: no se representa
                          ninguna posición deducida.
                        </p>
                      )}
                      <ul className="space-y-0.5 pl-3 text-[11px] text-slate-500 dark:text-slate-400">
                        {unplottedOwn.map((interval, index) => (
                          <li key={`u-int-${index}`}>{unplottedIntervalDetail(interval)}</li>
                        ))}
                        {unplottedOwnWaits.map((wait, index) => (
                          <li key={`u-wait-${index}`}>{unplottedWaitDetail(wait)}</li>
                        ))}
                      </ul>
                    </div>
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
