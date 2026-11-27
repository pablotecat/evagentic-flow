import type { DeliverableSnapshot } from '../api/types';
import {
  DELIVERABLE_ACQUISITION_LABELS,
  DELIVERABLE_ROLE_BADGES,
  DELIVERABLE_ROLE_LABELS,
  finalityText,
} from '../lib/deliverables';
import { isoOrUnobserved } from '../lib/trace';
import { noticeClass } from '../lib/ui';
import { CopyButton } from './CopyButton';

const badgeBase = 'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium';

const fallbackBadgeClass = 'border-slate-300 bg-slate-100 text-slate-600 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300';

const acquisitionBadgeClasses: Record<string, string> = {
  'runtime-content': 'border-teal-300 bg-teal-50 text-teal-700 dark:border-teal-700 dark:bg-teal-950/60 dark:text-teal-300',
  'post-event-file-read': 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-700 dark:bg-amber-950/60 dark:text-amber-300',
  unrecognized: 'border-red-300 bg-red-50 text-red-700 dark:border-red-700 dark:bg-red-950/60 dark:text-red-300',
};

const listText = (values: string[]): string => (values.length ? values.join(', ') : 'ninguna');

export function DeliverableCard({ snapshot }: { snapshot: DeliverableSnapshot }) {
  const value = snapshot.value;
  const unrecognized = snapshot.status !== 'captured';
  const role = value?.role ?? null;
  const roleBadge = role !== null ? DELIVERABLE_ROLE_BADGES[role] : undefined;
  const acquisitionMarker = unrecognized ? 'unrecognized'
    : value?.acquisition != null ? value.acquisition : 'unknown';
  const acquisitionLabel = unrecognized ? 'no reconocido'
    : value?.acquisition != null ? DELIVERABLE_ACQUISITION_LABELS[value.acquisition] ?? value.acquisition
    : 'adquisición desconocida';
  const roleFullLabel = role !== null ? DELIVERABLE_ROLE_LABELS[role] ?? role : 'rol desconocido';
  const content = !unrecognized && value != null ? value.content : null;
  return (
    <li
      data-deliverable-card
      className="space-y-2 rounded-xl border border-slate-200 bg-white/80 p-3 text-xs leading-relaxed dark:border-slate-800 dark:bg-slate-900/70"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span data-role={role ?? 'unknown'} className={`${badgeBase} ${roleBadge?.className ?? fallbackBadgeClass}`}>
          {roleBadge?.label ?? role ?? 'rol desconocido'}
        </span>
        <span
          data-acquisition={acquisitionMarker}
          className={`${badgeBase} ${acquisitionBadgeClasses[acquisitionMarker] ?? fallbackBadgeClass}`}
        >
          {acquisitionLabel}
        </span>
      </div>
      <p className="text-slate-700 dark:text-slate-300">
        Ruta:{' '}
        {value?.path != null
          ? <code className="rounded bg-slate-100 px-1 font-mono break-all dark:bg-slate-800">{value.path}</code>
          : <span className={noticeClass}>ruta no expuesta o no admitida</span>}
      </p>
      <p data-finality={value?.finality != null ? 'declared' : 'unknown'} className="text-slate-700 dark:text-slate-300">
        {finalityText(value)}
      </p>
      {content != null ? (
        <div className="relative overflow-hidden rounded-lg border border-slate-200 bg-slate-100 dark:border-slate-700 dark:bg-slate-900">
          <div className="absolute right-1.5 top-1.5 z-10">
            <CopyButton label="Copiar contenido" value={content} />
          </div>
          <pre
            data-deliverable-content
            className="overflow-x-auto p-3 pr-24 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap"
          >
            {content}
          </pre>
        </div>
      ) : unrecognized ? (
        <p data-absence="unrecognized" className={noticeClass}>
          Proyección no reconocida: la captura conservó el registro, pero no contenido, forma ni hash; no se reconstruye
          contenido no capturado.
        </p>
      ) : (
        <p data-absence="not-acquired" className={noticeClass}>
          Contenido no adquirido: la captura conserva la referencia y su motivo, no unos bytes ni una versión.
        </p>
      )}
      <details data-provenance className="rounded-lg border border-slate-200 dark:border-slate-800">
        <summary className="cursor-pointer select-none px-2 py-1 text-[11px] font-medium text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100">
          Procedencia y verificación
        </summary>
        <div className="space-y-1 p-2 text-slate-600 dark:text-slate-300">
          <p className="flex flex-wrap items-start gap-1">
            SHA-256 (base {snapshot.hashBasis ?? 'desconocida'}):
            {snapshot.sha256 != null ? (
              <>
                <code className="min-w-0 font-mono break-all">{snapshot.sha256}</code>
                <CopyButton label="Copiar SHA-256" value={snapshot.sha256} />
              </>
            ) : ' no disponible'}
          </p>
          <p>Adquisición: {acquisitionLabel}</p>
          <p>Origen: {snapshot.source ?? 'desconocida'}</p>
          <p>Papel: {roleFullLabel} · procedencia del papel: {value?.roleSource ?? 'desconocida'}</p>
          <p>Identidad: {snapshot.identity ?? 'desconocida'}</p>
          <p>
            Mensaje: {snapshot.messageID ?? 'desconocido'} · Llamada: {value?.callID ?? 'no expuesta'}
            {' '}· Evento: {snapshot.eventID ?? 'desconocido'}
          </p>
          <p>Momento de frontera: {isoOrUnobserved(value?.sourceTime)} (base {value?.sourceTimeBasis ?? 'desconocida'})</p>
          <p>Observación: {isoOrUnobserved(snapshot.observationTime)}</p>
          {snapshot.evidence != null ? (
            <p>
              Evidencia: {snapshot.evidence.captureID} · fila {snapshot.evidence.arrival}
              {' '}· {isoOrUnobserved(snapshot.evidence.observedAt)}
            </p>
          ) : <p>Evidencia: sin referencia</p>}
          <p>Omisiones: {listText(snapshot.omissions ?? [])}</p>
          <p>Redacciones: {listText(snapshot.redactions ?? [])}</p>
        </div>
      </details>
    </li>
  );
}
