import { useState } from 'react';
import type { PendingInteraction, StopResponseBody } from '../api/types';
import { api, isApiFailure } from '../api/client';
import { useExecutionDetail } from '../hooks/useExecutionDetail';
import { useTrace } from '../hooks/useTrace';
import { InteractionStateProvider } from '../hooks/useInteractionState';
import { EXECUTION_TABS, navigate, type ExecutionTab } from '../router/hash';
import { noticeClass } from '../lib/ui';
import { STOP_ERRORS } from '../lib/labels';
import { ExecutionHeader } from './ExecutionHeader';
import { PriorityBanner } from './PriorityBanner';
import { ConversationTab, type FocusRequest } from './ConversationTab';
import { DeliverablesTab } from './DeliverablesTab';
import { TraceTab, type TraceDimension } from './TraceTab';
import { TraceScopeBar } from './TraceScopeBar';

const TAB_LABELS: Record<ExecutionTab, string> = {
  conversation: 'Conversación',
  deliverables: 'Entregables',
  trace: 'Traza',
  evaluation: 'Evaluación',
};

const EVALUATION_PLACEHOLDER = 'Sin evaluación en este corte: el desenlace técnico no equivale a una aceptación.';

type Props = {
  id: string;
  tab: ExecutionTab;
  session: string | null;
  engineReachable: boolean | null;
};

export function ExecutionView({ id, tab, session, engineReachable }: Props) {
  const { detail, missing, reload } = useExecutionDetail(id);
  const trace = useTrace(id, session, {
    enabled: tab === 'trace',
    rootSessionID: detail?.execution.sessionID ?? null,
  });
  const [stopping, setStopping] = useState(false);
  const [stopRequest, setStopRequest] = useState<StopResponseBody | null>(null);
  const [stopError, setStopError] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  const [traceDimension, setTraceDimension] = useState<TraceDimension>('tree');
  if (missing && detail === null) {
    return (
      <section aria-label={`Ejecución ${id}`} className="pt-10 lg:pt-20">
        <h2 className="text-2xl font-semibold tracking-tight">Ejecución {id.slice(0, 8)}</h2>
        <p className={`${noticeClass} mt-4`}>No se pudo consultar la ejecución: puede que no exista en el índice persistente.</p>
      </section>
    );
  }
  if (detail === null) {
    return (
      <section aria-label={`Ejecución ${id}`} className="pt-10 lg:pt-20">
        <h2 className="text-2xl font-semibold tracking-tight">Ejecución {id.slice(0, 8)}</h2>
        <p className={`${noticeClass} mt-4`}>Consultando la evidencia persistida…</p>
      </section>
    );
  }
  const execution = detail.execution;
  const selectTab = (next: ExecutionTab) =>
    navigate({ view: 'execution', id, tab: next, session });
  const selectSession = (next: string | null) => {
    if (next === session) return;
    navigate({ view: 'execution', id, tab, session: next });
  };
  const requestStop = async () => {
    if (stopping) return;
    setStopping(true);
    setStopError(null);
    try {
      const body = await api<{ stop: StopResponseBody }>(`/api/executions/${encodeURIComponent(id)}/stop`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setStopRequest(body.stop);
    } catch (error) {
      const code = isApiFailure(error) ? error.body?.error : null;
      setStopError(STOP_ERRORS[typeof code === 'string' ? code : ''] ?? STOP_ERRORS.unknown);
    } finally {
      setStopping(false);
    }
    await reload();
  };
  const jumpToRequest = (item: PendingInteraction) => {
    navigate({ view: 'execution', id, tab: 'conversation', session });
    setFocusRequest(current => ({
      kind: item.kind,
      sessionID: item.sessionID,
      requestID: item.requestID,
      nonce: (current?.nonce ?? 0) + 1,
    }));
  };
  return (
    <section aria-label={`Ejecución ${execution.id}`}>
      <InteractionStateProvider id={id} reload={reload}>
        <div className="z-20 -mx-4 border-b border-slate-200 bg-slate-50/95 px-4 pb-2 pt-6 backdrop-blur sm:-mx-6 sm:px-6 lg:sticky lg:top-0 lg:pt-8 dark:border-slate-800 dark:bg-slate-950/95">
          <ExecutionHeader detail={detail} session={session} stopping={stopping} onStop={() => { void requestStop(); }} />
          <PriorityBanner
            detail={detail}
            engineReachable={engineReachable}
            stopRequest={stopRequest}
            stopError={stopError}
            onJump={jumpToRequest}
          />
          {tab === 'trace' && (
            <TraceScopeBar
              session={session}
              rootSessionID={execution.sessionID}
              knownSessions={trace.rootTree?.sessionIDs ?? null}
              onSelectSession={selectSession}
            />
          )}
        </div>
        <div role="tablist" aria-label="Secciones de la ejecución" className="mt-4 flex gap-1 border-b border-slate-200 dark:border-slate-700">
          {EXECUTION_TABS.map(candidate => {
            const selected = candidate === tab;
            return (
              <button
                key={candidate}
                type="button"
                role="tab"
                id={`tab-${candidate}`}
                aria-selected={selected}
                aria-controls={`panel-${candidate}`}
                onClick={() => selectTab(candidate)}
                className={`-mb-px rounded-t-lg border-b-2 px-3 py-2 text-sm font-medium transition-colors ${selected
                  ? 'border-sky-500 text-sky-600 dark:border-sky-400 dark:text-sky-300'
                  : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'}`}
              >
                {TAB_LABELS[candidate]}
              </button>
            );
          })}
        </div>
        <div
          role="tabpanel"
          id={`panel-${tab}`}
          aria-labelledby={`tab-${tab}`}
          className="py-6 text-sm leading-relaxed"
        >
          {tab === 'conversation'
            ? <ConversationTab detail={detail} focusRequest={focusRequest} />
            : tab === 'deliverables'
              ? <DeliverablesTab
                execution={execution}
                knownSessions={trace.rootTree?.sessionIDs ?? null}
                selectedSession={session}
                onSelectSession={selectSession}
              />
              : tab === 'trace'
                ? <TraceTab
                  session={session}
                  trace={trace.trace}
                  rootTree={trace.rootTree}
                  rootReason={trace.rootReason}
                  rootSessionID={execution.sessionID}
                  dimension={traceDimension}
                  onDimensionChange={setTraceDimension}
                  onSelectSession={selectSession}
                />
                : <p className={noticeClass}>{EVALUATION_PLACEHOLDER}</p>}
        </div>
      </InteractionStateProvider>
    </section>
  );
}
