import { noticeClass } from '../lib/ui';
import { TraceScopeBar } from './TraceScopeBar';

type Props = {
  session: string | null;
  rootSessionID: string | null;
  onSelectSession: (session: string | null) => void;
};

export function DeliverablesTab({ session, rootSessionID, onSelectSession }: Props) {
  return (
    <TraceScopeBar
      session={session}
      rootSessionID={rootSessionID}
      showKnownSessions={false}
      label="Alcance de los entregables"
      marker="deliverables"
      className="space-y-2 rounded-xl border border-slate-200 bg-white/70 px-3 py-2 text-xs dark:border-slate-800 dark:bg-slate-900/70"
      onSelectSession={onSelectSession}
    >
      <p className={noticeClass}>
        Los entregables conservados en la captura se mostrarán en una vista dedicada; la consulta se acotará exactamente a este alcance sin mezclar sesiones.
      </p>
    </TraceScopeBar>
  );
}
