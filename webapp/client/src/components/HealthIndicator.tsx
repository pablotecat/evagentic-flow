import { useState } from 'react';
import { ChevronDown, CircleAlert, HeartPulse } from 'lucide-react';
import type { HealthState } from '../hooks/useHealth';

export type HealthSignal = { key: string; ok: boolean | null; label: string; detail: string };

const CAPTURE_LABELS: Record<string, string> = {
  prepared: 'preparada',
  failed: 'fallo del registrador',
  'no-evidence': 'sin declaraciones de captura',
  unavailable: 'no disponible',
};

export function healthSignals({ health, connected }: HealthState): HealthSignal[] {
  const signals: HealthSignal[] = [{
    key: 'local',
    ok: connected ? true : false,
    label: connected ? 'App local' : 'Sin conexión con la app local',
    detail: connected
      ? 'La conexión con la app local está activa.'
      : 'Sin conexión con la app local: los datos reflejan la última respuesta conocida.',
  }];
  if (health === null) return signals;
  signals.push({
    key: 'engine',
    ok: health.engine.reachable ? true : false,
    label: health.engine.reachable
      ? `Motor disponible${health.engine.version ? ` (${health.engine.version})` : ''}`
      : 'Motor no disponible',
    detail: health.engine.reachable
      ? `El motor responde en la interfaz pública; versión declarada: ${health.engine.version ?? 'desconocida'}.`
      : 'El motor no responde: los desenlaces no comprobados permanecen pendientes y el encargo no se reenvía.',
  });
  const capture = health.capture?.status ?? 'unavailable';
  const captureOk = capture === 'prepared';
  signals.push({
    key: 'capture',
    ok: captureOk ? true : capture === 'no-evidence' ? null : false,
    label: capture === 'failed'
      ? 'Fallo del registrador'
      : `Captura ${CAPTURE_LABELS[capture] ?? capture}`,
    detail: capture === 'failed'
      ? 'El registrador declaró fallo: la captura requiere revisión antes de volver a ejecutar.'
      : capture === 'prepared'
        ? 'La captura del destino configurado está preparada.'
        : capture === 'no-evidence'
          ? 'El destino de captura no tiene declaraciones de preparación o fallo.'
          : `La captura no es consultable: ${health.capture?.reason ?? 'motivo desconocido'}.`,
  });
  const indexOk = health.index?.status === 'available';
  signals.push({
    key: 'index',
    ok: indexOk ? true : false,
    label: indexOk ? 'Índice disponible' : 'Índice: revisión requerida',
    detail: indexOk
      ? 'El índice persistente de ejecuciones está disponible.'
      : 'El índice persistente requiere revisión: los nuevos lanzamientos se rechazan mientras tanto.',
  });
  return signals;
}

export function HealthIndicator({ state }: { state: HealthState }) {
  const [expanded, setExpanded] = useState(false);
  const signals = healthSignals(state);
  const disconnected = signals.some(signal => signal.ok === false);
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800/60">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls="health-detail"
        aria-label="Salud del sistema"
        onClick={() => setExpanded(current => !current)}
        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
      >
        {disconnected
          ? <CircleAlert className="size-4 shrink-0 text-red-500" aria-hidden="true" />
          : <HeartPulse className="size-4 shrink-0 text-emerald-500" aria-hidden="true" />}
        <span className="flex flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
          {disconnected
            ? <span role="alert" className="font-medium text-red-600 dark:text-red-400">Sin conexión con la app local</span>
            : signals.map(signal => (
              <span key={signal.key} className="flex items-center gap-1">
                <span
                  aria-hidden="true"
                  className={`size-1.5 rounded-full ${signal.ok === true ? 'bg-emerald-500'
                    : signal.ok === false ? 'bg-red-500' : 'bg-amber-500'}`}
                />
                {signal.label}
              </span>
            ))}
        </span>
        <ChevronDown
          className={`size-3.5 shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </button>
      {expanded && (
        <ul id="health-detail" aria-label="Detalle de salud del sistema" className="space-y-1.5 border-t border-slate-200 px-3 py-2 text-[11px] leading-snug text-slate-600 dark:border-slate-700 dark:text-slate-300">
          {signals.map(signal => (
            <li key={signal.key} data-signal={signal.key} className="flex gap-1.5">
              <span
                aria-hidden="true"
                className={`mt-1 size-1.5 shrink-0 rounded-full ${signal.ok === true ? 'bg-emerald-500'
                  : signal.ok === false ? 'bg-red-500' : 'bg-amber-500'}`}
              />
              <span><span className="font-medium text-slate-800 dark:text-slate-200">{signal.label}.</span> {signal.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
