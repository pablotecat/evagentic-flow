import type {
  CostMetric,
  ModelStep,
  TokenCounts,
  TraceMeasurement,
  TraceResponse,
} from '../api/types';
import { evidenceText, isoOrUnobserved, uniqueKeys } from '../lib/trace';
import { noticeClass } from '../lib/ui';

type Props = {
  trace: TraceResponse;
};

type TokenColumn = { key: string; label: string };

const BASE_TOKEN_COLUMNS: TokenColumn[] = [
  { key: 'input', label: 'Entrada' },
  { key: 'output', label: 'Salida' },
  { key: 'reasoning', label: 'Razonamiento' },
  { key: 'cache.read', label: 'Caché lectura' },
  { key: 'cache.write', label: 'Caché escritura' },
];

const STEP_OUTCOME_LABELS: Record<string, string> = {
  ended: 'terminado',
  failed: 'fallido',
  ambiguous: 'ambiguo: sin colapsar resultados múltiples',
  'not-observed': 'sin desenlace observado',
};

const MEASUREMENT_OUTCOME_LABELS: Record<string, string> = {
  ended: 'terminado',
  failed: 'fallido',
  updated: 'actualizado',
  started: 'iniciado',
  streamed: 'en streaming',
};

const tableClass = 'w-full border-collapse text-left text-xs';
const cellClass = 'border border-slate-300 px-2 py-1 align-top dark:border-slate-600';

const numberOrUnknown = (value: number | null): string =>
  value === null || value === undefined ? 'desconocido' : String(value);

const tokensPresent = (metric: { value: TokenCounts | null }): TokenCounts | null => metric.value;

const tokenValue = (value: TokenCounts | null, key: string): number | null => {
  if (value === null) return null;
  if (key.startsWith('cache.')) {
    const nested = (value.cache as Record<string, unknown>)[key.slice('cache.'.length)];
    return typeof nested === 'number' ? nested : null;
  }
  const direct = (value as unknown as Record<string, unknown>)[key];
  return typeof direct === 'number' ? direct : null;
};

const extraTokenColumns = (steps: ModelStep[]): TokenColumn[] => {
  const extras = new Set<string>();
  for (const step of steps) {
    const value = tokensPresent(step.tokens);
    if (value === null) continue;
    for (const key of Object.keys(value)) {
      if (key === 'cache') {
        for (const nested of Object.keys(value.cache)) {
          if (nested !== 'read' && nested !== 'write') extras.add(`cache.${nested}`);
        }
      } else if (!['input', 'output', 'reasoning'].includes(key)) extras.add(key);
    }
  }
  return [...extras].map(key => ({ key, label: key }));
};

const modelLabel = (metric: { value: { providerID: string; id: string } | null; status: string }): string =>
  metric.value === null || metric.value === undefined
    ? 'desconocido'
    : `${metric.value.providerID}/${metric.value.id}`;

const metricProvenance = (metric: TokensOrCost): string => `estado: ${metric.status}`
  + ` · fuente: ${metric.source ?? 'ninguna'} · alcance: ${metric.scope ?? 'desconocido'}`
  + `${metric.basis ? ` · base: ${metric.basis}` : ''}`;

type TokensOrCost = CostMetric | { value: TokenCounts | null; status: string; source: string | null; scope: string; basis?: string };

const costCell = (metric: CostMetric): string =>
  metric.value === null || metric.value === undefined ? 'desconocido' : `${metric.value} USD`;

const stepOutcomeLabel = (outcome: string): string =>
  STEP_OUTCOME_LABELS[outcome] ?? outcome ?? 'desconocido';

const measurementOutcomeLabel = (outcome: string): string =>
  MEASUREMENT_OUTCOME_LABELS[outcome] ?? outcome ?? 'desconocido';

const dispatchesRetriesCell = (step: ModelStep): string => {
  const dispatches = Array.isArray(step.dispatches) ? String(step.dispatches.length) : 'desconocido';
  const retries = Array.isArray(step.retries) ? String(step.retries.length) : 'desconocido';
  return `${dispatches} / ${retries}`;
};

const scheduledDelayText = (value: number | null | undefined): string =>
  value === null || value === undefined ? 'desconocida' : `${value} ms`;

const pendingInboxLabel = (state: string): string => {
  if (state === 'unknown') {
    return 'Admisión con resolución observada sin orden acreditado (estado desconocido)';
  }
  if (state === 'delivery-not-observed' || state === 'pending') {
    return 'Admisión sin entrega observada';
  }
  return `Admisión pendiente (${state})`;
};

const tokenCells = (
  columns: TokenColumn[],
  value: TokenCounts | null,
  extraAttributes: boolean,
) => columns.map(column => (
  <td
    key={column.key}
    className={`${cellClass} font-mono`}
    {...extraAttributes ? { 'data-token-column': column.key } : {}}
  >
    {numberOrUnknown(tokenValue(value, column.key))}
  </td>
));

export function TraceMetricsView({ trace }: Props) {
  const metrics = trace.metrics;
  const steps = metrics.steps ?? [];
  const measurements = metrics.measurements ?? [];
  const pendingInbox = metrics.pendingInbox ?? [];
  const coverage = metrics.coverage ?? null;
  const tokenColumns = [...BASE_TOKEN_COLUMNS, ...extraTokenColumns(steps)];
  const stepKeys = uniqueKeys(steps, step => {
    const firstEvidence = step.evidence?.[0];
    const ref = firstEvidence ? `${firstEvidence.captureID}:${firstEvidence.arrival}` : 'sin-evidencia';
    return `${step.sessionID}:${step.messageID ?? 'sin-mensaje'}:${ref}`;
  });
  const measurementKeys = uniqueKeys(measurements, item => {
    const firstEvidence = item.evidence?.[0];
    const ref = firstEvidence ? `${firstEvidence.captureID}:${firstEvidence.arrival}` : 'sin-evidencia';
    return `${item.sessionID ?? 'sin-sesion'}:${item.kind}:${item.outcome}:${ref}`;
  });
  const pendingInboxKeys = uniqueKeys(pendingInbox, item => {
    const firstEvidence = item.evidence?.[0];
    const ref = firstEvidence ? `${firstEvidence.captureID}:${firstEvidence.arrival}` : item.state;
    return `${item.sessionID}:${item.messageID ?? 'sin-mensaje'}:${ref}`;
  });
  return (
    <section aria-label="Métricas del modelo con fuente y alcance" className="space-y-3">
      <h4 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
        Métricas del modelo con fuente y alcance
      </h4>
      <p className={noticeClass}>
        El consumo de tokens es el valor normalizado que informa el runtime; no prueba el consumo original del
        proveedor. El coste es una estimación del runtime, no una factura. Un valor ausente permanece desconocido,
        nunca cero.
      </p>
      {steps.length === 0 ? (
        <p className={noticeClass}>Sin pasos de modelo observados en el alcance.</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table data-metrics-steps aria-label="Pasos de modelo con tokens desglosados" className={tableClass}>
              <thead>
                <tr>
                  <th className={cellClass}>Sesión</th>
                  <th className={cellClass}>Mensaje</th>
                  <th className={cellClass}>Modelo</th>
                  {tokenColumns.map(column => (
                    <th key={column.key} className={cellClass}>{column.label}</th>
                  ))}
                  <th className={cellClass}>Coste (USD, estimado)</th>
                  <th className={cellClass}>Duración</th>
                  <th className={cellClass}>Despachos / reintentos</th>
                  <th className={cellClass}>Desenlace</th>
                </tr>
              </thead>
              <tbody>
                {steps.map((step, index) => (
                  <tr key={stepKeys[index]} data-metric-step-row className="font-mono">
                    <td className={`${cellClass} break-all`}>{step.sessionID}</td>
                    <td className={`${cellClass} break-all`}>{step.messageID ?? 'desconocido'}</td>
                    <td className={cellClass}>{modelLabel(step.model)}</td>
                    {tokenCells(tokenColumns, tokensPresent(step.tokens), true)}
                    <td className={cellClass} data-metric-cost>{costCell(step.costUSD)}</td>
                    <td className={cellClass} data-metric-duration>
                      {step.elapsedMs === null || step.elapsedMs === undefined
                        ? 'desconocido' : `${step.elapsedMs} ms`}
                    </td>
                    <td className={cellClass} data-metric-dispatches>{dispatchesRetriesCell(step)}</td>
                    <td className={cellClass}>{stepOutcomeLabel(step.outcome)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul aria-label="Fuente, alcance y despachos por paso de modelo" className="space-y-1">
            {steps.map((step, index) => (
              <li key={stepKeys[index]}>
                <details data-metric-details className="rounded-lg border border-slate-200 dark:border-slate-800">
                  <summary className="cursor-pointer select-none px-2 py-1 text-[11px] font-medium text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100">
                    Paso de modelo · sesión {step.sessionID} · mensaje {step.messageID ?? 'desconocido'}
                  </summary>
                  <div className="space-y-1 p-2 pl-3 text-[11px] leading-relaxed text-slate-600 dark:text-slate-300">
                    <p>Modelo: {modelLabel(step.model)} (estado {step.model?.status ?? 'unknown'})</p>
                    <p>Tokens ({metricProvenance(step.tokens)})</p>
                    <p>Coste ({metricProvenance(step.costUSD)})</p>
                    <p>
                      Tiempos: inicio {isoOrUnobserved(step.startedAt)} · primer byte {' '}
                      {isoOrUnobserved(step.streamedAt)} · fin {isoOrUnobserved(step.endedAt)} · cuerpo del proveedor:{' '}
                      {step.providerBodyMs === null || step.providerBodyMs === undefined
                        ? 'desconocido' : `${step.providerBodyMs} ms`}
                    </p>
                    <p>Fuente de duración: {step.durationSource ?? 'desconocida'}</p>
                    {step.finish !== null && step.finish !== undefined && (
                      <p>Fin declarado: {step.finish}</p>
                    )}
                    {step.error !== null && step.error !== undefined && (
                      <p>
                        Error: {step.error.type}: {step.error.message}
                        {typeof step.error.status === 'number' ? ` (HTTP ${step.error.status})` : ''}
                      </p>
                    )}
                    <p>
                      Despachos observados: {step.dispatches?.length ?? 0}
                      {step.dispatches?.length ? ` (${step.dispatches
                        .map(dispatch => isoOrUnobserved(dispatch.startedAt)).join(', ')})` : ''};
                      no se atribuye consumo por proximidad.
                    </p>
                    {step.retries?.length ? (
                      <p>
                        Reintentos de modelo observados: {step.retries.length}
                        {step.retries.map(retry => ` · intento ${retry.attempt} en ${isoOrUnobserved(retry.at)}: `
                          + `${retry.error.type}: ${retry.error.message}`
                          + `${typeof retry.error.status === 'number' ? ` (HTTP ${retry.error.status})` : ''}`
                          + ` · espera programada: ${scheduledDelayText(retry.scheduledDelayMs)}`).join('')}
                        ; consumo y espera real por intento desconocidos.
                      </p>
                    ) : null}
                    {step.results?.length ? (
                      <p>
                        Resultados observados: {step.results
                          .map(result => `${result.phase}${result.finish ? ` (${result.finish})` : ''}`)
                          .join(', ')}
                      </p>
                    ) : null}
                    {step.omissions?.length ? <p>Omisiones: {step.omissions.join(', ')}</p> : null}
                    <p>Evidencia: {evidenceText(step.evidence ?? [])}</p>
                  </div>
                </details>
              </li>
            ))}
          </ul>
        </>
      )}
      {measurements.length > 0 && (
        <div className="space-y-1">
          <h5 className="text-xs font-semibold text-slate-700 dark:text-slate-200">Mediciones adicionales observadas</h5>
          <div className="overflow-x-auto">
            <table data-metrics-measurements aria-label="Mediciones adicionales observadas" className={tableClass}>
              <thead>
                <tr>
                  <th className={cellClass}>Tipo</th>
                  <th className={cellClass}>Desenlace</th>
                  <th className={cellClass}>Sesión</th>
                  <th className={cellClass}>Modelo</th>
                  {tokenColumns.map(column => (
                    <th key={column.key} className={cellClass}>{column.label}</th>
                  ))}
                  <th className={cellClass}>Coste (USD, estimado)</th>
                  <th className={cellClass}>Fuente y alcance</th>
                  <th className={cellClass}>Error, omisiones y evidencia</th>
                </tr>
              </thead>
              <tbody>
                {measurements.map((item: TraceMeasurement, index) => (
                  <tr key={measurementKeys[index]} className="font-mono">
                    <td className={cellClass}>{item.kind ?? 'medición'}</td>
                    <td className={cellClass}>{measurementOutcomeLabel(item.outcome)}</td>
                    <td className={`${cellClass} break-all`}>{item.sessionID ?? 'desconocida'}</td>
                    <td className={cellClass}>{modelLabel(item.model)}</td>
                    {tokenCells(tokenColumns, tokensPresent(item.tokens), false)}
                    <td className={cellClass}>{costCell(item.costUSD)}</td>
                    <td className={`${cellClass} font-sans text-[11px] leading-relaxed`} data-measurement-provenance>
                      <p>Tokens ({metricProvenance(item.tokens)})</p>
                      <p>Coste ({metricProvenance(item.costUSD)})</p>
                      <p>
                        Modelo (estado: {item.model?.status ?? 'unknown'} · fuente: {item.model?.source ?? 'ninguna'}
                        {' · alcance: '}
                        {item.model?.scope ?? 'desconocido'})
                      </p>
                    </td>
                    <td className={`${cellClass} font-sans text-[11px] leading-relaxed`} data-measurement-details>
                      {item.error !== null && item.error !== undefined && (
                        <p>
                          Error: {item.error.type}: {item.error.message}
                          {typeof item.error.status === 'number' ? ` (HTTP ${item.error.status})` : ''}
                        </p>
                      )}
                      <p>Omisiones: {item.omissions?.length ? item.omissions.join(', ') : 'ninguna'}</p>
                      <p>Evidencia: {item.evidence?.length ? evidenceText(item.evidence) : 'no observada'}</p>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {pendingInbox.length > 0 && (
        <div className="space-y-1">
          <h5 className="text-xs font-semibold text-slate-700 dark:text-slate-200">Inbox pendiente por sesión</h5>
          <ul aria-label="Inbox pendiente por sesión" className="space-y-0.5">
            {pendingInbox.map((item, index) => (
              <li
                key={pendingInboxKeys[index]}
                data-pending-inbox={item.sessionID}
                data-pending-state={item.state}
                className={noticeClass}
              >
                {pendingInboxLabel(item.state)} · sesión {item.sessionID} · mensaje{' '}
                {item.messageID ?? 'desconocido'} · estado: {item.state}
              </li>
            ))}
          </ul>
          <p className={noticeClass}>
            El inbox pendiente es propio de cada sesión; una entrega no acredita aceptación ni éxito y no se totalizan
            mensajes entre sesiones.
          </p>
        </div>
      )}
      {coverage !== null && (
        <div className="space-y-1">
          <h5 className="text-xs font-semibold text-slate-700 dark:text-slate-200">Cobertura de métricas</h5>
          <p className={noticeClass}>
            La duración total del flujo no se expone (flowElapsedMs desconocido) y no se suman ramas concurrentes.
          </p>
          {coverage.omissions?.length ? (
            <p className={noticeClass}>Omisiones de métricas: {coverage.omissions.join(', ')}.</p>
          ) : null}
          {coverage.recorderDiagnostics?.length ? (
            <p className={noticeClass}>
              Diagnósticos del registrador en el alcance: {coverage.recorderDiagnostics
                .map(item => `${item.type}: ${item.reason ?? 'sin motivo'} · ${item.captureID} · fila ${item.arrival}`)
                .join(' | ')}.
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}
