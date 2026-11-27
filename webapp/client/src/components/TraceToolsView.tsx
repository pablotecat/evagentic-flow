import { useState } from 'react';
import type { ToolAttempt, TraceResponse } from '../api/types';
import { evidenceText, isoOrUnobserved, uniqueKeys } from '../lib/trace';
import { chipClass, noticeClass } from '../lib/ui';
import { CopyButton } from './CopyButton';
import { JsonDisclosure, formatJson } from './JsonDisclosure';

type Props = {
  trace: TraceResponse;
};

const OUTCOME_LABELS: Record<string, string> = {
  success: 'éxito observado (concluido)',
  error: 'error observado (fallido)',
  'not-observed': 'sin desenlace observado: desconocido; puede ser trabajo en curso y no acredita fallo, éxito ni consumo cero',
};

const badgeBase = 'inline-block rounded-full px-2 py-0.5 text-[11px] font-medium';

const OUTCOME_BADGE_CLASSES: Record<string, string> = {
  success: `${badgeBase} bg-emerald-100 text-emerald-800 ring-1 ring-emerald-300 dark:bg-emerald-950/70 dark:text-emerald-200 dark:ring-emerald-700`,
  error: `${badgeBase} bg-rose-100 text-rose-800 ring-1 ring-rose-300 dark:bg-rose-950/70 dark:text-rose-200 dark:ring-rose-700`,
  'not-observed': `${badgeBase} border border-dashed border-amber-500 bg-amber-50 text-amber-800 dark:border-amber-400/70 dark:bg-amber-950/40 dark:text-amber-200`,
};

const outcomeLabel = (outcome: string): string => OUTCOME_LABELS[outcome] ?? outcome;

const attemptBaseKey = (attempt: ToolAttempt): string => {
  const firstEvidence = attempt.evidence?.[0];
  const ref = firstEvidence ? `${firstEvidence.captureID}:${firstEvidence.arrival}` : 'sin-evidencia';
  return `${attempt.sessionID}:${attempt.messageID ?? 'sin-mensaje'}:${attempt.callID ?? 'sin-llamada'}:${ref}`;
};

type OutcomeFilter = '' | 'success' | 'error' | 'not-observed';

export function TraceToolsView({ trace }: Props) {
  const [nameFilter, setNameFilter] = useState('');
  const [outcomeFilter, setOutcomeFilter] = useState<OutcomeFilter>('');
  const attempts = trace.tools.attempts ?? [];
  const attemptKeys = uniqueKeys(attempts, attemptBaseKey);
  const needle = nameFilter.trim().toLowerCase();
  const filtered = attempts
    .map((attempt, index) => ({ key: attemptKeys[index], attempt }))
    .filter(({ attempt }) => {
      const matchesName = needle === ''
        || (attempt.toolName ?? '').toLowerCase().includes(needle);
      const matchesOutcome = outcomeFilter === '' || attempt.outcome === outcomeFilter;
      return matchesName && matchesOutcome;
    });
  return (
    <section aria-label="Herramientas e intentos" className="space-y-2">
      <h4 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Herramientas e intentos</h4>
      <p className={noticeClass} data-tools-scope-notice>
        Esta vista lista solo los intentos de herramienta de la sesión seleccionada ({trace.selectedSessionID}
        {trace.rootSessionID === trace.selectedSessionID ? ', sesión raíz' : ''}), sin incluir descendientes; para
        inspeccionar las herramientas de una subejecución, selecciónala en el árbol.
      </p>
      <p className={noticeClass} data-consumption-notice>
        Consumo: desconocido, no cero. No se agrupan reintentos por nombre, argumentos ni proximidad: este runtime no
        expone el enlace entre intentos (retryOf y operationID desconocidos) y cada intento conserva su propio
        desenlace.
      </p>
      <p className={noticeClass}>
        Cada fila es una llamada individual con el orden exacto de la evidencia: una llamada sin desenlace observado
        permanece desconocida y no acredita fallo, éxito ni consumo cero.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          aria-label="Filtrar por nombre de herramienta"
          placeholder="Filtrar por nombre de herramienta"
          value={nameFilter}
          onChange={event => setNameFilter(event.target.value)}
          className="w-56 rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs text-slate-800 placeholder:text-slate-400 focus:border-sky-500 focus:outline-none dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
        />
        <select
          aria-label="Filtrar por desenlace"
          value={outcomeFilter}
          onChange={event => setOutcomeFilter(event.target.value as OutcomeFilter)}
          className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs text-slate-800 focus:border-sky-500 focus:outline-none dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
        >
          <option value="">Todos los desenlaces</option>
          <option value="success">Concluido: éxito observado</option>
          <option value="error">Fallido: error observado</option>
          <option value="not-observed">Sin desenlace observado (desconocido)</option>
        </select>
        <span className={chipClass}>
          {attempts.length === filtered.length
            ? `Intentos observados en el alcance: ${attempts.length}`
            : `Mostrando ${filtered.length} de ${attempts.length} intentos`}
        </span>
      </div>
      {attempts.length === 0 ? (
        <p className={noticeClass}>Sin llamadas de herramienta observadas en el alcance actual de la evidencia.</p>
      ) : filtered.length === 0 ? (
        <p className={noticeClass}>Ningún intento coincide con los filtros actuales.</p>
      ) : (
        <ul aria-label="Intentos de herramienta en orden de evidencia" className="space-y-2">
          {filtered.map(({ key, attempt }) => (
            <li
              key={key}
              data-tool-attempt
              data-tool-name={attempt.toolName ?? 'desconocido'}
              data-outcome={attempt.outcome}
              className="space-y-1.5 rounded-xl border border-slate-200 bg-white/70 p-3 dark:border-slate-800 dark:bg-slate-900/70"
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-mono text-sm font-semibold break-all text-slate-800 dark:text-slate-100">
                  {attempt.toolName ?? 'nombre no observado'}
                </span>
                <span className={OUTCOME_BADGE_CLASSES[attempt.outcome] ?? OUTCOME_BADGE_CLASSES['not-observed']}>
                  {outcomeLabel(attempt.outcome)}
                </span>
              </div>
              {attempt.input !== null || attempt.inputText !== null ? (
                <JsonDisclosure
                  summary="Entrada autorizada"
                  marker="input"
                  text={attempt.input !== null ? formatJson(attempt.input) : (attempt.inputText as string)}
                  copyLabel={attempt.input !== null ? 'Copiar JSON' : 'Copiar texto'}
                />
              ) : (
                <p className={noticeClass}>Entrada: no observada o no autorizada.</p>
              )}
              {attempt.output !== null ? (
                <JsonDisclosure summary="Resultado autorizado" marker="output" text={formatJson(attempt.output)} />
              ) : (
                <p className={noticeClass}>Resultado: no observado o no autorizado.</p>
              )}
              {attempt.error !== null && (
                <JsonDisclosure summary="Error observado" marker="error" text={formatJson(attempt.error)} />
              )}
              <details data-disclosure="forensics" className="rounded-lg border border-slate-200 dark:border-slate-800">
                <summary className="cursor-pointer select-none px-2 py-1 text-[11px] font-medium text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100">
                  Detalles forenses
                </summary>
                <div className="space-y-1 p-2 pl-3 text-[11px] leading-relaxed text-slate-600 dark:text-slate-300">
                  <p className="flex flex-wrap items-center gap-1">
                    Sesión: <span className="font-mono break-all">{attempt.sessionID}</span>
                    <CopyButton label="Copiar sesión" value={attempt.sessionID} />
                  </p>
                  <p className="flex flex-wrap items-center gap-1">
                    Mensaje: <span className="font-mono break-all">{attempt.messageID ?? 'desconocido'}</span>
                    {attempt.messageID !== null && (
                      <CopyButton label="Copiar mensaje" value={attempt.messageID as string} />
                    )}
                  </p>
                  <p className="flex flex-wrap items-center gap-1">
                    Llamada: <span className="font-mono break-all">{attempt.callID ?? 'desconocida'}</span>
                    {attempt.callID !== null && (
                      <CopyButton label="Copiar llamada" value={attempt.callID as string} />
                    )}
                  </p>
                  <p>
                    Tiempos: inicio {isoOrUnobserved(attempt.startedAt)} · llamada{' '}
                    {isoOrUnobserved(attempt.calledAt)} · fin {isoOrUnobserved(attempt.endedAt)}
                  </p>
                  <p>
                    Incidente:{' '}
                    {attempt.incident === null
                      ? 'sin incidente registrado'
                      : `${attempt.incident.kind} (${attempt.incident.cause ?? 'causa desconocida'})`}
                  </p>
                  <p>Evidencia: {evidenceText(attempt.evidence ?? [])}</p>
                  <p>
                    Omisiones: {attempt.omissions?.length ? attempt.omissions.join(', ') : 'ninguna'}
                  </p>
                </div>
              </details>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
