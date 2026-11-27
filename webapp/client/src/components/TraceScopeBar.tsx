import type { ReactNode } from 'react';
import { CopyButton } from './CopyButton';

type Props = {
  session: string | null;
  rootSessionID: string | null;
  knownSessions?: string[] | null;
  showKnownSessions?: boolean;
  label?: string;
  marker?: 'trace' | 'deliverables';
  className?: string;
  children?: ReactNode;
  onSelectSession: (session: string | null) => void;
};

export const sessionScopeKind = (session: string, rootSessionID: string | null): string =>
  (session === rootSessionID ? 'sesión raíz' : 'subejecución');

export const scopeSummary = (
  session: string | null,
  rootSessionID: string | null,
  knownCount: number | null,
): string => (session === null
  ? `toda la ejecución${knownCount !== null ? ` · ${knownCount} sesiones conocidas` : ''}`
  : `${sessionScopeKind(session, rootSessionID)} ${session}`);

const defaultClass = 'mt-2 space-y-2 rounded-xl border border-slate-200 bg-white/80 px-3 py-2 text-xs dark:border-slate-800 dark:bg-slate-900/80';

export function TraceScopeBar({
  session,
  rootSessionID,
  knownSessions = null,
  showKnownSessions = true,
  label = 'Alcance de la consulta de traza',
  marker = 'trace',
  className = defaultClass,
  children,
  onSelectSession,
}: Props) {
  return (
    <section
      aria-label={label}
      data-trace-scope-bar={marker === 'trace' ? '' : undefined}
      data-deliverables-scope={marker === 'deliverables' ? '' : undefined}
      className={className}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {session === null ? (
          <p data-scope="full" className="min-w-0 text-slate-700 dark:text-slate-300">
            Alcance: <strong className="font-semibold">toda la ejecución</strong>
            {showKnownSessions && (knownSessions !== null
              ? ` · ${knownSessions.length} sesiones conocidas`
              : ' · sesiones conocidas: no observadas')}
          </p>
        ) : (
          <>
            <p data-scope="session" className="text-slate-700 dark:text-slate-300">
              Alcance: <strong className="font-semibold">{sessionScopeKind(session, rootSessionID)}</strong>
            </p>
            <span data-scope-session={session} className="min-w-0 font-mono break-all text-slate-700 dark:text-slate-300">{session}</span>
            <CopyButton value={session} label="Copiar subejecución" />
            <button
              type="button"
              onClick={() => onSelectSession(null)}
              className="rounded-lg border border-sky-500 px-2 py-0.5 font-medium text-sky-600 transition-colors hover:bg-sky-50 dark:border-sky-400 dark:text-sky-300 dark:hover:bg-sky-950/50"
            >
              Ver toda la ejecución
            </button>
          </>
        )}
      </div>
      {children}
    </section>
  );
}
