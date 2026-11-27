import { noticeClass } from '../lib/ui';

type Props = {
  session: string | null;
  rootSessionID: string | null;
  onSelectSession: (session: string | null) => void;
};

export function DeliverablesTab({ session, rootSessionID, onSelectSession }: Props) {
  return (
    <section
      aria-label="Alcance de los entregables"
      data-deliverables-scope
      className="space-y-2 rounded-xl border border-slate-200 bg-white/70 px-3 py-2 text-xs dark:border-slate-800 dark:bg-slate-900/70"
    >
      {session === null ? (
        <p data-scope="full" className="text-slate-700 dark:text-slate-300">
          Alcance: <strong className="font-semibold">toda la ejecución</strong>
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <p data-scope="session" className="text-slate-700 dark:text-slate-300">
            Alcance: <strong className="font-semibold">{session === rootSessionID ? 'sesión raíz' : 'subejecución'}</strong>
          </p>
          <span data-scope-session={session} className="min-w-0 font-mono break-all text-slate-700 dark:text-slate-300">{session}</span>
          <button
            type="button"
            onClick={() => onSelectSession(null)}
            className="rounded-lg border border-sky-500 px-2 py-0.5 font-medium text-sky-600 transition-colors hover:bg-sky-50 dark:border-sky-400 dark:text-sky-300 dark:hover:bg-sky-950/50"
          >
            Ver toda la ejecución
          </button>
        </div>
      )}
      <p className={noticeClass}>
        Los entregables conservados en la captura se mostrarán en una vista dedicada; la consulta se acotará exactamente a este alcance sin mezclar sesiones.
      </p>
    </section>
  );
}
