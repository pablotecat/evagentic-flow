import { OctagonX } from 'lucide-react';
import type { ExecutionDetail } from '../api/types';
import { chipClass, noticeClass } from '../lib/ui';
import { isTerminal } from '../lib/labels';
import { StatusBadge } from './StatusBadge';
import { CopyButton } from './CopyButton';

type Props = {
  detail: ExecutionDetail;
  session: string | null;
  stopping: boolean;
  onStop: () => void;
};

const knownAgentText = (detail: ExecutionDetail): string => {
  const execution = detail.execution;
  if (execution.knownAgent) return `${execution.knownAgent} (procedencia: API pública de la sesión)`;
  return execution.requestedAgent ? 'sin confirmar todavía' : 'sin selección';
};

const knownModelText = (detail: ExecutionDetail): string => {
  const execution = detail.execution;
  if (execution.knownModel?.value) return `${execution.knownModel.value} (procedencia: API pública de la sesión)`;
  return execution.requestedModel ? 'sin confirmar todavía' : 'sin selección';
};

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 py-1.5 sm:grid-cols-[190px_1fr] sm:gap-3">
      <dt className="text-[11px] font-semibold tracking-wide text-slate-500 dark:text-slate-400">{label}</dt>
      <dd className="min-w-0 space-y-1 text-xs leading-relaxed break-words text-slate-700 dark:text-slate-300">{children}</dd>
    </div>
  );
}

export function ExecutionHeader({ detail, session, stopping, onStop }: Props) {
  const execution = detail.execution;
  const capture = detail.capture;
  const knownModel = execution.knownModel?.value ?? null;
  const terminal = isTerminal(execution.status);
  const canStop = !terminal && execution.sessionID !== null;
  const captures = capture?.readable
    ? (capture.captureIDs.length ? capture.captureIDs.join(', ') : 'sin filas de captura de esta ejecución')
    : `no consultable: ${capture?.reason ?? 'desconocido'}`;
  const scopeText = capture?.readable && capture.scope?.sessionIDs?.length
    ? capture.scope.sessionIDs.join(', ') : null;
  return (
    <header>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-2xl font-semibold tracking-tight">Ejecución {execution.id.slice(0, 8)}</h2>
        <StatusBadge status={execution.status} />
        {canStop && (
          <button
            type="button"
            onClick={onStop}
            disabled={stopping}
            className="ml-auto inline-flex items-center gap-1.5 rounded-xl bg-red-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-red-500 dark:hover:bg-red-400"
          >
            <OctagonX className="size-4" aria-hidden="true" />
            {stopping ? 'Deteniendo…' : 'Detener'}
          </button>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
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
      <details className="mt-2 rounded-xl border border-slate-200 bg-white/70 dark:border-slate-800 dark:bg-slate-900/70">
        <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium text-slate-700 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100">
          Metadatos y evidencia
        </summary>
        <div className="border-t border-slate-200 px-3 py-2 dark:border-slate-800">
          <dl className="divide-y divide-slate-100 dark:divide-slate-800/60">
            <MetaRow label="Ejecución">
              <div className="flex min-w-0 items-center gap-2">
                <span className="font-mono break-words">{execution.id}</span>
                <CopyButton value={execution.id} label="Copiar identificador completo" />
              </div>
            </MetaRow>
            <MetaRow label="Agente">
              Elegido: {execution.requestedAgent ?? 'ninguno'} · Conocido: {knownAgentText(detail)}
            </MetaRow>
            <MetaRow label="Modelo">
              Elegido: {execution.requestedModel ?? 'ninguno'} · Conocido: {knownModelText(detail)}
            </MetaRow>
            <MetaRow label="Comando">
              {execution.requestedCommand ? execution.requestedCommand.name : 'encargo directo sin comando'}
            </MetaRow>
            <MetaRow label="Sesión raíz">
              {execution.sessionID ? (
                <div className="flex min-w-0 items-center gap-2">
                  <span className="font-mono break-words">{execution.sessionID}</span>
                  <CopyButton value={execution.sessionID} label="Copiar sesión raíz" />
                </div>
              ) : 'sin sesión confirmada'}
            </MetaRow>
            <MetaRow label="Capturas">
              {capture?.readable && capture.captureIDs.length > 0 ? (
                <div className="flex min-w-0 items-center gap-2">
                  <span className="font-mono break-words">{capture.captureIDs.join(', ')}</span>
                  <CopyButton value={capture.captureIDs.join(', ')} label="Copiar capturas" />
                </div>
              ) : captures}
            </MetaRow>
            <MetaRow label="Evidencia hasta (máximo observado)">
              {capture?.readable ? (
                <>
                  <span className="font-mono break-words">{capture.horizon ?? 'sin eventos observados'}</span>
                  <p className={noticeClass}>máximo observado en el árbol; los horizontes por diario están en la cobertura</p>
                </>
              ) : 'horizonte desconocido'}
            </MetaRow>
            <MetaRow label="Alcance de evidencia">
              {scopeText ? (
                <>
                  Árbol de sesiones observado: <span className="font-mono break-words">{scopeText}</span>
                </>
              ) : capture?.readable ? 'Árbol de sesiones observado: ninguno' : 'desconocido'}
            </MetaRow>
            {!!capture?.gaps?.length && (
              <MetaRow label="Lagunas del destino de captura">
                <p className={noticeClass}>Sin atribución a esta ejecución: la captura no identifica la sesión afectada. No hay replay ni relleno de texto.</p>
                <ul className="space-y-1">
                  {capture.gaps.map(gap => (
                    <li key={`${gap.captureID}:${gap.arrival}`} className="font-mono break-words">
                      {gap.captureID} · fila {gap.arrival} · {gap.observedAt ? new Date(gap.observedAt).toISOString() : 'momento no observado'}: {gap.reason ?? 'sin motivo declarado'}
                    </li>
                  ))}
                </ul>
              </MetaRow>
            )}
            {!!capture?.omissions?.length && (
              <MetaRow label="Omisiones observadas">
                <ul className="space-y-1">
                  {capture.omissions.map((row, index) => (
                    <li key={`${row.sessionID}:${row.captureID ?? index}:${row.arrival ?? index}`} className="font-mono break-words">
                      {row.sessionID} · {row.captureID} · fila {row.arrival} · {row.type}: {(row.omissions ?? []).join(', ')}
                    </li>
                  ))}
                </ul>
              </MetaRow>
            )}
          </dl>
        </div>
      </details>
    </header>
  );
}
