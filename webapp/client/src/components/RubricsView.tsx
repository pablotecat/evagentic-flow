import { useMemo, useState } from 'react';
import type { RubricGroup, RubricVersion } from '../api/types';
import { useRubrics } from '../hooks/useRubrics';
import { RUBRIC_VERSION_STATUS, versionStatusOf } from '../lib/evaluation';
import { isoOrUnobserved } from '../lib/trace';
import { chipClass, noticeClass, alertClass } from '../lib/ui';
import { CopyButton } from './CopyButton';
import { JsonDisclosure } from './JsonDisclosure';

const badgeClass = 'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset';

const versionKey = (rubric: RubricGroup, version: RubricVersion): string =>
  `${rubric.rubricID}\u0000${version.version ?? ''}`;

export function RubricsView() {
  const { body } = useRubrics();
  return (
    <section data-rubrics-view aria-label="Rúbricas" className="pt-10 lg:pt-20">
      <h2 className="text-2xl font-semibold tracking-tight">Rúbricas</h2>
      <div className="mt-6 space-y-4">
        {body === null ? (
          <p data-rubrics-loading className={noticeClass}>Consultando las rúbricas conocidas…</p>
        ) : body.state === 'read-error' ? (
          <p data-rubrics-unreadable role="alert" className={alertClass}>
            Las rúbricas no están consultables ({body.reason ?? 'desconocido'}); no se generan versiones de
            ejemplo.
          </p>
        ) : body.rubrics.length === 0 ? (
          <div data-rubrics-empty className="rounded-xl border border-slate-200 bg-white/60 p-4 dark:border-slate-800 dark:bg-slate-900/50">
            <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Sin rúbricas versionadas</h3>
            <p className={`${noticeClass} mt-1`}>
              No existe ninguna rúbrica versionada. La revisión, el versionado de las rúbricas y el agente juez son
              trabajos posteriores a esta entrega: el borrador del documento de rúbrica inicial no es una rúbrica
              aprobada y esta vista no lo usa como dato.
            </p>
          </div>
        ) : (
          <>
            <p className={noticeClass}>
              Vista de sólo lectura de contenido y versiones históricas de las rúbricas. Las evaluaciones
              referencian la versión exacta que aplicaron; una versión borrador o desconocida no se presenta como
              versión aprobada.
            </p>
            {body.rubrics.some(rubric => rubric.versions.some(version => version.status === 'approved')) ? null : (
              <p className={noticeClass}>
                Ninguna rúbrica tiene una versión aprobada explícitamente identificada.
              </p>
            )}
            <RubricsMasterDetail rubrics={body.rubrics} />
          </>
        )}
        {body !== null && body.state === 'ready' ? <RubricAnomalies body={body} /> : null}
      </div>
    </section>
  );
}

function RubricAnomalies({ body }: { body: { anomalies?: { withoutRubricID: number; duplicateVersions: Array<{ rubricID: string; version: string | null }> } } }) {
  const anomalies = body.anomalies;
  if (anomalies === undefined) return null;
  return (
    <>
      {anomalies.withoutRubricID > 0 ? (
        <p role="alert" data-anomaly="sin-rubricID" className={alertClass}>
          {anomalies.withoutRubricID} fila(s) de rúbricas sin identificador no se muestran como rúbrica.
        </p>
      ) : null}
      {anomalies.duplicateVersions.map(duplicate => (
        <p key={`${duplicate.rubricID}-${duplicate.version ?? ''}`} role="alert" data-anomaly="version-duplicada" className={alertClass}>
          Versión duplicada: {duplicate.rubricID} · {duplicate.version ?? 'no identificada'}; su estado no se
          resuelve.
        </p>
      ))}
    </>
  );
}

function RubricsMasterDetail({ rubrics }: { rubrics: RubricGroup[] }) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const effective = useMemo(() => {
    for (const rubric of rubrics) {
      for (const version of rubric.versions) {
        if (versionKey(rubric, version) === selectedKey) return { rubric, version };
      }
    }
    const first = rubrics[0];
    const version = first.versions[0];
    return version === undefined ? null : { rubric: first, version };
  }, [rubrics, selectedKey]);
  return (
    <div className="grid gap-4 md:grid-cols-[minmax(220px,1fr)_2fr]">
      <nav aria-label="Rúbricas versionadas" className="space-y-3 rounded-xl border border-slate-200 bg-white/70 p-3 dark:border-slate-800 dark:bg-slate-900/70">
        {rubrics.map(rubric => {
          const selectedHere = effective !== null && effective.rubric.rubricID === rubric.rubricID;
          return (
            <div key={rubric.rubricID} data-rubric-master={rubric.rubricID} className="space-y-1">
              <button
                type="button"
                data-rubric-select={rubric.rubricID}
                aria-current={selectedHere ? 'true' : undefined}
                onClick={() => setSelectedKey(versionKey(rubric, rubric.versions[0]))}
                className={`flex w-full flex-col gap-0.5 rounded-lg border px-2.5 py-1.5 text-left transition-colors ${selectedHere
                  ? 'border-sky-400 bg-sky-50 dark:border-sky-500 dark:bg-sky-950/50'
                  : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800'}`}
              >
                <span className="font-mono text-xs break-all text-slate-800 dark:text-slate-100">{rubric.rubricID}</span>
                <span className={noticeClass}>{rubric.title ?? 'título no disponible'}</span>
              </button>
              <ul className="space-y-1">
                {rubric.versions.map((version, index) => {
                  const active = effective !== null
                    && effective.rubric.rubricID === rubric.rubricID
                    && effective.version === version;
                  const status = versionStatusOf(version);
                  return (
                    <li key={`${version.version ?? ''}-${index}`}>
                      <button
                        type="button"
                        data-version-select={version.version ?? ''}
                        aria-current={active ? 'true' : undefined}
                        onClick={() => setSelectedKey(versionKey(rubric, version))}
                        className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1 text-left text-xs transition-colors ${active
                          ? 'bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200'
                          : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'}`}
                      >
                        <span className="truncate">Versión {version.version ?? 'no identificada'}</span>
                        <span className={`${badgeClass} shrink-0 ${RUBRIC_VERSION_STATUS[status].tone}`}>
                          {RUBRIC_VERSION_STATUS[status].label}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>
      {effective !== null ? <RubricDetail rubric={effective.rubric} version={effective.version} /> : null}
    </div>
  );
}

function RubricDetail({ rubric, version }: { rubric: RubricGroup; version: RubricVersion }) {
  const status = versionStatusOf(version);
  return (
    <section
      data-rubric-detail={rubric.rubricID}
      data-rubric-detail-version={version.version ?? ''}
      aria-label="Detalle de la versión de rúbrica"
      className="space-y-3 rounded-xl border border-slate-200 bg-white/70 p-4 dark:border-slate-800 dark:bg-slate-900/70"
    >
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
          Rúbrica <span className="font-mono text-xs break-all font-normal">{rubric.rubricID}</span>
        </h3>
        <CopyButton label="Copiar rúbrica" value={rubric.rubricID} />
        <span className={chipClass}>{rubric.title ?? 'título no disponible'}</span>
      </header>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs">
          Versión {version.version !== null ? (
            <>
              <span className="font-mono">{version.version}</span>
              <CopyButton label="Copiar versión" value={version.version} className="ml-1" />
            </>
          ) : 'no identificada'}
        </span>
        <span data-rubric-status={status} className={`${badgeClass} ${RUBRIC_VERSION_STATUS[status].tone}`}>
          {RUBRIC_VERSION_STATUS[status].label}
        </span>
      </div>
      <p className={noticeClass}>Observada: {isoOrUnobserved(version.observedAt)}</p>
      {version.criteria.length > 0 ? (
        <ul className="space-y-1 text-xs leading-relaxed text-slate-700 dark:text-slate-300">
          {version.criteria.map((criterion, index) => (
            <li key={`${criterion.id ?? ''}-${index}`} data-rubric-criterion={criterion.id ?? ''}>
              Criterio {criterion.id ?? 'desconocido'} — {criterion.title ?? 'título no disponible'}{' '}
              {criterion.mandatory ? (
                <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-200">Obligatorio</span>
              ) : (
                <span className={noticeClass}>no obligatorio</span>
              )}
              {' '}(peso {criterion.weight ?? 'desconocido'})
            </li>
          ))}
        </ul>
      ) : (
        <p className={noticeClass}>Sin criterios declarados en esta versión.</p>
      )}
      {version.content !== null ? (
        <JsonDisclosure
          summary="Contenido histórico de la versión"
          text={version.content}
          marker="rubric-content"
          copyLabel="Copiar contenido"
        />
      ) : (
        <p className={noticeClass}>Contenido de la versión no disponible.</p>
      )}
    </section>
  );
}
