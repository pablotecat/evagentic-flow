import type { DeliverableSessionGroup, Execution } from '../api/types';
import { useDeliverables } from '../hooks/useDeliverables';
import { snapshotKeyParts } from '../lib/deliverables';
import { uniqueKeys } from '../lib/trace';
import { alertClass, noticeClass } from '../lib/ui';
import { CopyButton } from './CopyButton';
import { DeliverableCard } from './DeliverableCard';
import { TraceScopeBar } from './TraceScopeBar';

const scopeBarClass = 'space-y-2 rounded-xl border border-slate-200 bg-white/70 px-3 py-2 text-xs dark:border-slate-800 dark:bg-slate-900/70';

const partialStatuses: Execution['status'][] = ['failed', 'interrupted'];

type Props = {
  execution: Execution;
  knownSessions?: string[] | null;
  selectedSession: string | null;
  onSelectSession: (session: string | null) => void;
};

export function DeliverablesTab({ execution, knownSessions = null, selectedSession, onSelectSession }: Props) {
  const { body } = useDeliverables(execution.id, selectedSession);
  const scopeSessions = body !== null && body.readable ? body.scope?.sessionIDs ?? null : null;
  const shownKnownSessions = scopeSessions ?? knownSessions;
  const queryMode = body !== null && body.readable ? body.query?.mode ?? null : null;
  const failedGroups = body !== null && body.readable
    ? body.sessions.filter(group => group.readable === false)
    : [];
  const showPartialRead = body !== null && body.readable
    && failedGroups.length > 0 && failedGroups.length < body.sessions.length;
  const partialResults = partialStatuses.includes(execution.status);
  return (
    <div className="space-y-4">
      <TraceScopeBar
        session={selectedSession}
        rootSessionID={execution.sessionID}
        knownSessions={shownKnownSessions}
        label="Alcance de los entregables"
        marker="deliverables"
        className={scopeBarClass}
        onSelectSession={onSelectSession}
      >
        {body !== null && body.readable && queryMode !== null ? (
          <p data-query-mode={queryMode} className={noticeClass}>
            {queryMode === 'selected-session'
              ? `Consulta de una sola sesión (${body.selectedSessionID}): no incluye los entregables de sus descendientes.`
              : 'Vista de conjunto: reúne explícitamente las sesiones conocidas del árbol acreditado, consultadas una a una; una consulta de raíz no incluye descendientes.'}
          </p>
        ) : null}
      </TraceScopeBar>
      {partialResults ? (
        <p
          data-partial-results
          role="status"
          className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm leading-relaxed text-amber-900 dark:border-amber-700 dark:bg-amber-950/60 dark:text-amber-200"
        >
          Resultados parciales de una ejecución fallida o interrumpida: consultarlos no equivale a éxito ni a
          aceptación.
        </p>
      ) : null}
      {body === null ? (
        <p data-deliverables-loading className={noticeClass}>
          Consultando las respuestas autorizadas y los snapshots conservados en la captura…
        </p>
      ) : !body.readable ? (
        <p data-deliverables-unreadable role="alert" className={alertClass}>
          Los entregables no están consultables ({body.reason ?? 'desconocido'}); no se reconstruye contenido no
          capturado.
        </p>
      ) : (
        <>
          <section
            data-epistemic-notice
            aria-label="Matiz epistémico de los entregables"
            className="rounded-xl border border-slate-200 bg-white/70 p-3 dark:border-slate-800 dark:bg-slate-900/70"
          >
            <p className={noticeClass}>
              Se consulta la versión conservada en la captura, no el archivo actual: esta consulta no relee archivos
              del proyecto observado y cambiar o eliminar el original no altera lo mostrado. Un snapshot puede
              contener el contenido capturado del propio evento del runtime o proceder de una lectura posterior al
              acontecimiento, que no acredita qué bytes produjo o utilizó la acción original. La finalidad de cada
              snapshot es la declarada por la evidencia; la finalidad global no está acreditada y un papel de salida
              en una herramienta no acredita que este contenido sea el resultado final del flujo.
            </p>
          </section>
          {showPartialRead ? (
            <p data-partial-read className={noticeClass}>
              Lectura parcial de la evidencia: {failedGroups.length} sesión(es) del alcance no pudieron leerse; las
              demás se muestran con su evidencia real y las fallidas no invalidan a las demás.
            </p>
          ) : null}
          <DeliverableGroups sessions={body.sessions} />
        </>
      )}
    </div>
  );
}

function DeliverableGroups({ sessions }: { sessions: DeliverableSessionGroup[] }) {
  const groupKeys = uniqueKeys(sessions, group => group.sessionID);
  return (
    <div className="space-y-6">
      {sessions.map((group, index) => (
        <SessionSection key={groupKeys[index]} group={group} />
      ))}
    </div>
  );
}

function SessionSection({ group }: { group: DeliverableSessionGroup }) {
  const cardKeys = uniqueKeys(group.deliverables, snapshotKeyParts);
  const responseKeys = uniqueKeys(group.responses, response => response.text);
  return (
    <section
      data-session-group={group.sessionID}
      aria-label={group.isRoot ? 'Entregables de la sesión raíz' : `Entregables de la subejecución ${group.sessionID}`}
      className="space-y-3 rounded-xl border border-slate-200 bg-white/60 p-3 dark:border-slate-800 dark:bg-slate-900/50"
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
          {group.isRoot ? 'Sesión raíz' : 'Subejecución'}
        </h3>
        {!group.isRoot ? (
          <>
            <span className="min-w-0 font-mono text-xs break-all text-slate-600 dark:text-slate-300">{group.sessionID}</span>
            <CopyButton label="Copiar subejecución" value={group.sessionID} />
          </>
        ) : null}
        {group.readable ? (
          <span data-snapshot-count className="ml-auto text-[11px] text-slate-500 dark:text-slate-400">
            Snapshots conservados: {group.deliverables.length}
          </span>
        ) : null}
      </header>
      {group.readable === false ? (
        <p role="alert" data-session-read-error={group.sessionID} className={alertClass}>
          Lectura de esta sesión fallida ({group.reason ?? 'desconocido'}); resultado parcial: no se reconstruye
          contenido no capturado.
        </p>
      ) : group.deliverables.length === 0 ? (
        <p className={noticeClass}>
          Sin entregables capturados para esta sesión; la ausencia no acredita que no existieran archivos en el
          proyecto.
        </p>
      ) : (
        <ul data-deliverable-cards={group.sessionID} className="grid gap-3 md:grid-cols-2">
          {group.deliverables.map((snapshot, cardIndex) => (
            <DeliverableCard key={cardKeys[cardIndex]} snapshot={snapshot} />
          ))}
        </ul>
      )}
      {group.responses.length > 0 ? (
        <details data-responses={group.sessionID} className="rounded-lg border border-slate-200 dark:border-slate-800">
          <summary className="cursor-pointer select-none px-2 py-1 text-[11px] font-medium text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100">
            Respuestas autorizadas de esta sesión ({group.responses.length})
          </summary>
          <div className="space-y-1 p-2">
            {group.responses.map((response, responseIndex) => (
              <p key={responseKeys[responseIndex]} className={noticeClass}>
                Respuesta autorizada: {response.text}
              </p>
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}
