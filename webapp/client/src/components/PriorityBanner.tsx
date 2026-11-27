import type { ExecutionDetail, PendingInteraction, StopResponseBody } from '../api/types';
import { alertClass, noticeClass } from '../lib/ui';
import { isTerminal, readErrorMessage, sessionLabel, STOP_REQUEST_LABELS } from '../lib/labels';

type Props = {
  detail: ExecutionDetail;
  engineReachable: boolean | null;
  stopRequest: StopResponseBody | null;
  stopError: string | null;
  onJump: (item: PendingInteraction) => void;
};

const bannerAlertClass = 'rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm leading-relaxed text-amber-950 dark:border-amber-700 dark:bg-amber-950/60 dark:text-amber-100 dark:[&_.notice]:text-amber-200/75';

export function PriorityBanner({ detail, engineReachable, stopRequest, stopError, onJump }: Props) {
  const execution = detail.execution;
  const recorder = detail.recorder;
  const capture = detail.capture;
  const interactions = detail.interactions ?? { pending: [], resolved: [], readErrors: [] };
  const stop = detail.stop ?? { requested: false };
  const recorderAlert = capture?.recorderFailed
    || (recorder?.readable === true && (recorder.status === 'failed' || recorder.reviewRequired === true));
  const engineOffline = engineReachable === false && !isTerminal(execution.status);
  const hasPending = interactions.pending.length > 0 || interactions.readErrors.length > 0;
  if (!recorderAlert && !engineOffline && !stop.requested && !hasPending && !stopError) return null;
  const captureState = capture?.readable
    ? (capture.recorderFailed ? 'fallo del registrador declarado en la captura' : 'consultable')
    : `no consultable (${capture?.reason ?? 'desconocido'})`;
  const recorderReviewText = recorder?.readable === true
    ? (recorder.reviewRequired === false
      ? 'Revisión no declarada como requerida por el motor.'
      : 'Revisión requerida según la evidencia pública del motor.')
    : `No se pudieron leer los metadatos públicos del registrador en el motor (${recorder?.reason ?? 'motivo desconocido'}); la captura declara fallo del registrador y revisión requerida.`;
  return (
    <section role="region" aria-label="Atención prioritaria" data-priority-banner="true" className="mt-2 space-y-2">
      {recorderAlert && (
        <div role="alert" aria-label="Fallo del registrador" className={`${alertClass} border-red-300 dark:border-red-800`}>
          <h3 className="text-sm font-semibold">Fallo del registrador</h3>
          <p>Aviso: revisar antes de volver a ejecutar. Estado de captura: {captureState}.</p>
          <p>
            {recorderReviewText}
            {' '}Se conserva el bloqueo durable de la captura: no hay desbloqueo automático, ni por recargar ni por reparar la ruta.
          </p>
          {recorder?.readable === true && recorder.notice ? <p className={noticeClass}>{recorder.notice}</p> : null}
          {recorder?.readable === true && recorder.interruption ? (
            <p className={noticeClass}>
              Interrupción: {recorder.interruption.requested ? 'solicitada' : 'no solicitada'}, detención{' '}
              {recorder.interruption.stop === 'confirmed' ? 'confirmada' : 'no confirmada'}.
            </p>
          ) : null}
          {recorder?.readable === true && recorder.reason ? (
            <p className={noticeClass}>Motivo público declarado: {recorder.reason}.</p>
          ) : null}
        </div>
      )}
      {engineOffline && (
        <p role="alert" className={bannerAlertClass}>
          Motor no disponible: desenlace pendiente de comprobar; el encargo no se reenviará.
        </p>
      )}
      {stop.requested && (
        <div role="alert" aria-label="Detención solicitada" className={bannerAlertClass}>
          <h3 className="text-sm font-semibold">Detención solicitada</h3>
          <p className={noticeClass}>
            La detención actúa sólo sobre el alcance verificado de esta ejecución. Una solicitud aceptada no es una detención
            confirmada: no hay interrupción instantánea, pausa, reanudación ni reversión de efectos externos, y el encargo no se reenvía.
          </p>
          <ul className="mt-2 space-y-1">
            {(stop.sessions ?? []).map(session => {
              const request = (stopRequest?.sessions ?? []).find(item => item.sessionID === session.sessionID);
              return (
                <li key={session.sessionID}>
                  {sessionLabel(execution, session.sessionID)} · Solicitud: {request
                    ? STOP_REQUEST_LABELS[request.result] ?? request.result : 'sin comprobar'} · Detención: {session.stop === 'confirmed'
                      ? 'confirmada'
                      : 'no confirmada'} · desenlace público: {session.outcome ?? 'desconocido'}
                </li>
              );
            })}
          </ul>
          {stop.treeVerified === false ? (
            <p className="mt-2 font-medium">
              No se pudo verificar el árbol de sesiones; los descendientes nuevos no pudieron comprobarse.
            </p>
          ) : null}
          {stop.readError ? (
            <p className="mt-2 font-medium">
              No se pudo comprobar el desenlace público de la detención; se mantiene no confirmada y el trabajo no se relanza.
            </p>
          ) : null}
        </div>
      )}
      {interactions.readErrors.map((error, index) => (
        <p key={`read-error-${index}`} role="alert" className={`${alertClass} border-amber-300 dark:border-amber-700`}>
          {readErrorMessage(error)}
        </p>
      ))}
      {interactions.pending.length > 0 && (
        <div role="alert" aria-label="Intervención pendiente" className={bannerAlertClass}>
          <h3 className="text-sm font-semibold">Esperando intervención</h3>
          <p className={noticeClass}>
            La ejecución espera intervención: conserva su identidad, no se cierra ni falla por esperar, y responder no lanza otro encargo.
          </p>
          <ul className="mt-2 space-y-1.5">
            {interactions.pending.map(item => (
              <li key={`${item.kind}:${item.sessionID}:${item.requestID}`} className="flex flex-wrap items-center gap-2">
                <span>
                  {item.kind === 'form' ? 'Pregunta nativa' : 'Permiso nativo'} · {sessionLabel(execution, item.sessionID)} ·{' '}
                  {item.request?.title ?? item.request?.action ?? 'sin detalle observable'}
                </span>
                <button
                  type="button"
                  onClick={() => onJump(item)}
                  className="rounded-lg border border-amber-400 bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-950 transition-colors hover:bg-amber-200 dark:border-amber-600 dark:bg-amber-900 dark:text-amber-100 dark:hover:bg-amber-800"
                >
                  Ir a la solicitud
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {stopError && <p role="alert" className={alertClass}>{stopError}</p>}
    </section>
  );
}
