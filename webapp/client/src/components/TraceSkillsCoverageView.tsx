import type { SkillObservation, TraceResponse } from '../api/types';
import { evidenceText, isoOrUnobserved } from '../lib/trace';
import { chipClass, noticeClass } from '../lib/ui';
import { CopyButton } from './CopyButton';
import { JsonDisclosure } from './JsonDisclosure';

type Props = {
  trace: TraceResponse;
};

const SKILL_ORIGIN_LABELS: Record<string, string> = {
  'successful-skill-tool-result': 'resultado correcto de una llamada de skill',
  'runtime-activation-event': 'evento público de activación del runtime',
};

const PLUGIN_SOURCE_LABELS: Record<string, string> = {
  builtin: 'integrado',
  local: 'local',
  package: 'paquete',
  sdk: 'SDK',
};

const PLUGIN_STATUS_LABELS: Record<string, string> = {
  active: 'activo',
  failed: 'fallido',
};

const headerClass = 'text-sm font-semibold text-slate-800 dark:text-slate-100';

const provenanceLine = (item: SkillObservation): string =>
  `${item.source ? `fuente ${item.source} · ` : ''}observada ${isoOrUnobserved(item.observationTime)}`
  + ` · evidencia: ${evidenceText([item.evidence])}`;

const registryValue = (value: unknown): { identity: string; path: string | null; content: string | null } => {
  if (value === null || typeof value !== 'object') return { identity: 'identidad desconocida', path: null, content: null };
  const record = value as Record<string, unknown>;
  const identity = typeof record.id === 'string' && record.id.length > 0
    ? record.id : 'identidad desconocida';
  const path = typeof record.path === 'string' && record.path.length > 0 ? record.path : null;
  const content = typeof record.content === 'string' ? record.content : null;
  return { identity, path, content };
};

const HashLine = ({ item }: { item: SkillObservation }) => (
  <p className="flex flex-wrap items-center gap-1 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
    SHA-256 ({item.hashBasis}): <span className="font-mono break-all">{item.sha256 ?? 'no disponible'}</span>
    {item.sha256 !== null && <CopyButton label="Copiar SHA-256" value={item.sha256 as string} />}
  </p>
);

const observedSkillCard = (item: TraceResponse['skills']['observed'][number], key: string) => (
  <li
    key={key}
    data-skill-observed={item.skill.id}
    className="space-y-1 rounded-xl border border-slate-200 bg-white/70 p-3 dark:border-slate-800 dark:bg-slate-900/70"
  >
    <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
      Skill observada: {item.skill.name ?? item.skill.id}
    </p>
    <p className={noticeClass}>
      Origen: {SKILL_ORIGIN_LABELS[item.skill.origin] ?? item.skill.origin} · sesión {item.sessionID} · mensaje{' '}
      {item.messageID ?? 'desconocido'} · llamada {item.callID ?? 'desconocida'}
    </p>
    <p className={noticeClass}>Evidencia: {evidenceText([item.evidence])}</p>
    <p className="flex flex-wrap items-center gap-1 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
      SHA-256 del contenido filtrado: <span className="font-mono break-all">{item.skill.sha256}</span>
      <CopyButton label="Copiar SHA-256" value={item.skill.sha256} />
    </p>
    <JsonDisclosure summary="Contenido autorizado (filtrado)" marker="skill-content" text={item.skill.text} />
  </li>
);

const admittedLine = (item: SkillObservation, key: string) => {
  const value = item.value as { id?: string; name?: string } | null;
  return (
    <li key={key} data-skill-admitted={value?.id ?? key}>
      Skill admitida {value?.id ?? 'desconocida'}{value?.name ? ` (${value.name})` : ''} · mensaje{' '}
      {item.messageID ?? 'desconocido'} · la admisión no prueba despacho por el modelo
      <p className={noticeClass}>Procedencia: {provenanceLine(item)}</p>
    </li>
  );
};

const availableList = (item: SkillObservation) => {
  const value = Array.isArray(item.value) ? item.value : [];
  return value.map((skill, index) => (
    <li key={`${item.evidence.arrival}:${index}`} data-skill-available={skill.id}>
      {skill.id}{skill.name ? ` (${skill.name})` : ''}
      {index === 0 ? <p className={noticeClass}>Procedencia: {provenanceLine(item)}</p> : null}
    </li>
  ));
};

const definitionCard = (item: SkillObservation, key: string) => {
  const { identity, path, content } = registryValue(item.value);
  const name = (item.value as { name?: string } | null)?.name;
  return (
    <li
      key={key}
      data-skill-definition={item.identity ?? key}
      className="space-y-1 rounded-xl border border-slate-200 bg-white/70 p-3 dark:border-slate-800 dark:bg-slate-900/70"
    >
      <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
        Definición observada ({item.source}): {identity}{name ? ` (${name})` : ''}
      </p>
      <p className={noticeClass}>
        Leída después del hecho ({isoOrUnobserved(item.observationTime)}); no es una foto histórica del inicio de la
        ejecución ni de ninguna activación. {path ? `Ruta: ${path}.` : 'Ruta no expuesta.'}
      </p>
      <p className={noticeClass}>Procedencia: {provenanceLine(item)}</p>
      <HashLine item={item} />
      {content !== null
        ? <JsonDisclosure summary="Contenido filtrado" marker="skill-content" text={content} />
        : <p className={noticeClass}>Contenido: no observado o no autorizado.</p>}
      {item.omissions?.length ? <p className={noticeClass}>Omisiones: {item.omissions.join(', ')}</p> : null}
    </li>
  );
};

const environmentCard = (item: SkillObservation, key: string) => {
  const plugins = Array.isArray((item.value as { plugins?: unknown[] } | null)?.plugins)
    ? (item.value as { plugins: Array<{ id: string | null; source: string | null; version: string | null; status: string | null }> }).plugins
    : [];
  return (
    <li key={key} className="space-y-1">
      {plugins.length ? (
        <ul className="space-y-0.5">
          {plugins.map((plugin, index) => (
            <li key={`${key}:${index}`} data-plugin={plugin.id ?? index}>
              {plugin.id}
              {' · fuente '}
              {PLUGIN_SOURCE_LABELS[plugin.source ?? ''] ?? plugin.source ?? 'desconocida'}
              {' · versión '}
              {plugin.version ?? 'desconocida'}
              {' · estado '}
              {PLUGIN_STATUS_LABELS[plugin.status ?? ''] ?? plugin.status ?? 'desconocido'}
            </li>
          ))}
        </ul>
      ) : (
        <p className={noticeClass}>Sin plugins observados.</p>
      )}
      <p className={noticeClass}>Procedencia: {provenanceLine(item)}</p>
      {item.sha256 !== null && <HashLine item={item} />}
    </li>
  );
};

export function TraceSkillsCoverageView({ trace }: Props) {
  const skills = trace.skills;
  const coverage = trace.captureDiagnostics;
  const observed = skills.observed ?? [];
  const admitted = skills.admitted ?? [];
  const available = skills.available ?? [];
  const definitions = skills.definitions ?? [];
  const environment = skills.environment ?? [];
  return (
    <section aria-label="Skills y cobertura de captura" className="space-y-4">
      <h4 className={headerClass}>Skills y cobertura de captura</h4>
      <section aria-label="Skills observadas" data-skills-observed className="space-y-2">
        <h5 className="text-xs font-semibold text-slate-700 dark:text-slate-200">
          Skills observadas (activación o carga efectiva)
        </h5>
        <p className={noticeClass}>
          Sólo estas skills tienen activación o carga efectiva acreditada durante la ejecución observada; la admisión
          o la disponibilidad no acreditan uso.
        </p>
        {observed.length ? (
          <ul className="space-y-2">{observed.map((item, index) => observedSkillCard(item, `${item.sessionID}:${item.callID ?? index}`))}</ul>
        ) : (
          <p className={noticeClass}>Ninguna skill fue observada en uso.</p>
        )}
      </section>
      {admitted.length ? (
        <section aria-label="Skills admitidas" data-skills-admitted className="space-y-2">
          <h5 className="text-xs font-semibold text-slate-700 dark:text-slate-200">
            Skills admitidas con el encargo
          </h5>
          <ul className="space-y-1 text-xs leading-relaxed text-slate-700 dark:text-slate-300">
            {admitted.map((item, index) => admittedLine(item, `${item.sessionID}:${item.messageID ?? index}`))}
          </ul>
        </section>
      ) : null}
      <section aria-label="Skills disponibles" data-skills-available className="space-y-2">
        <h5 className="text-xs font-semibold text-slate-700 dark:text-slate-200">
          Skills disponibles (disponibilidad; no prueba uso)
        </h5>
        {available.length ? (
          <>
            <ul className="space-y-1 text-xs leading-relaxed text-slate-700 dark:text-slate-300">
              {available.map((item, index) => (
                <li key={`${item.evidence.arrival}:${index}`} data-available-observation={index}>
                  <ul className="space-y-0.5">{availableList(item)}</ul>
                </li>
              ))}
            </ul>
            <p className={noticeClass}>
              Disponibilidad observada en un punto del hook; no garantiza selección final, permisos ni activación de
              las skills disponibles.
            </p>
          </>
        ) : (
          <p className={noticeClass}>Sin observaciones de disponibilidad.</p>
        )}
      </section>
      <section
        aria-label="Definiciones observadas del registro"
        data-skills-definitions
        className="space-y-2"
      >
        <h5 className="text-xs font-semibold text-slate-700 dark:text-slate-200">
          Definiciones observadas del registro y entorno (lecturas posteriores al hecho)
        </h5>
        <p className={noticeClass}>
          Definiciones y entorno se leyeron después del hecho: no son una foto histórica del inicio de la ejecución
          ni de ninguna activación.
        </p>
        {definitions.length ? (
          <ul className="space-y-2">
            {definitions.map((item, index) => definitionCard(item, `${item.source}:${item.identity ?? index}`))}
          </ul>
        ) : (
          <p className={noticeClass}>Sin definiciones observadas.</p>
        )}
      </section>
      <section aria-label="Entorno de plugins" data-plugin-environment className="space-y-2">
        <h5 className="text-xs font-semibold text-slate-700 dark:text-slate-200">
          Entorno de plugins (lectura posterior al hecho)
        </h5>
        {environment.length ? (
          <ul className="space-y-1 text-xs leading-relaxed text-slate-700 dark:text-slate-300">
            {environment.map((item, index) => environmentCard(item, `${item.source}:${item.identity ?? index}`))}
          </ul>
        ) : (
          <p className={noticeClass}>Sin observaciones de entorno.</p>
        )}
        <p className={noticeClass}>
          El listado no atribuye cada transformación a su autor, orden ni versión local; esos datos quedan
          desconocidos.
        </p>
      </section>
      <section aria-label="Cobertura de captura" data-capture-coverage className="space-y-2">
        <h5 className="text-xs font-semibold text-slate-700 dark:text-slate-200">
          Diagnóstico técnico y cobertura de captura
        </h5>
        {coverage === null ? (
          <p className={noticeClass}>Sin diagnóstico de cobertura disponible.</p>
        ) : (
          <>
            <p className="text-xs leading-relaxed text-slate-700 dark:text-slate-300">
              Disposición: sin evaluar (readiness: {coverage.readiness}).
            </p>
            <p className={noticeClass}>
              Los diagnósticos técnicos y la cobertura de captura no son una evaluación: la ausencia de incidentes no
              equivale a una aceptación ni acredita el piloto.
            </p>
            <p className={chipClass}>
              Sesiones con evidencia en el alcance: {coverage.sessions?.length ? coverage.sessions.join(', ') : 'ninguna'}
            </p>
            <h6 className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">
              Declaraciones de preparación
            </h6>
            {(coverage.declarations?.length ?? 0) ? (
              <ul className="space-y-0.5 text-[11px] leading-relaxed text-slate-600 dark:text-slate-300">
                {coverage.declarations.map((declaration, index) => {
                  const record = declaration as {
                    runtimeVersion?: string; sdkVersion?: string | null; recorderVersion?: string | null;
                    coverage?: { ordering?: string } | null;
                  };
                  return (
                    <li key={index}>
                      runtime {record.runtimeVersion ?? 'desconocido'} · SDK {record.sdkVersion ?? 'desconocida'}
                      {' · registrador '}
                      {record.recorderVersion ?? 'desconocida'} · orden {record.coverage?.ordering ?? 'desconocido'}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className={noticeClass}>Sin declaraciones de preparación en el alcance.</p>
            )}
            <details data-coverage-observed className="rounded-lg border border-slate-200 dark:border-slate-800">
              <summary className="cursor-pointer select-none px-2 py-1 text-[11px] font-medium text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100">
                Tipos y etapas observados
              </summary>
              <ul className="space-y-0.5 p-2 pl-3 text-[11px] leading-relaxed text-slate-600 dark:text-slate-300">
                {(coverage.observed ?? []).map((shape, index) => (
                  <li key={index}>
                    {shape.type}{shape.stage ? ` · ${shape.stage}` : ''}{shape.status ? ` · ${shape.status}` : ''} × {shape.count}
                  </li>
                ))}
              </ul>
            </details>
            <details data-coverage-omissions className="rounded-lg border border-slate-200 dark:border-slate-800">
              <summary className="cursor-pointer select-none px-2 py-1 text-[11px] font-medium text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100">
                Omisiones observadas
              </summary>
              <ul className="space-y-0.5 p-2 pl-3 text-[11px] leading-relaxed text-slate-600 dark:text-slate-300">
                {(coverage.omissions ?? []).map((omission, index) => (
                  <li key={index}>{omission}</li>
                ))}
              </ul>
            </details>
            <details data-coverage-diagnostics className="rounded-lg border border-slate-200 dark:border-slate-800">
              <summary className="cursor-pointer select-none px-2 py-1 text-[11px] font-medium text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100">
                Diagnósticos del registrador en el alcance
              </summary>
              <ul className="space-y-0.5 p-2 pl-3 text-[11px] leading-relaxed text-slate-600 dark:text-slate-300">
                {(coverage.diagnostics ?? []).map((row, index) => {
                  const record = row as { type?: string; reason?: string | null; captureID?: string; arrival?: number; sessionID?: string | null };
                  return (
                    <li key={index}>
                      {record.type}: {record.reason ?? 'sin motivo'} · {record.captureID} · fila {record.arrival}
                      {record.sessionID ? ` · sesión ${record.sessionID}` : ' · sesión no identificada'}
                    </li>
                  );
                })}
              </ul>
            </details>
            <details data-coverage-horizons className="rounded-lg border border-slate-200 dark:border-slate-800">
              <summary className="cursor-pointer select-none px-2 py-1 text-[11px] font-medium text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100">
                Horizonte de lectura por diario
              </summary>
              <p className={noticeClass}>
                El horizonte global de la traza es el máximo observado entre los diarios del alcance, no un corte
                común; los horizontes de cada diario figuran aquí.
              </p>
              <ul className="space-y-0.5 p-2 pl-3 text-[11px] leading-relaxed text-slate-600 dark:text-slate-300">
                {(coverage.horizons ?? []).map((horizon, index) => (
                  <li key={index}>
                    {horizon.captureID} · hasta la fila {horizon.arrival} · {new Date(horizon.observedAt).toISOString()}
                  </li>
                ))}
              </ul>
            </details>
          </>
        )}
      </section>
    </section>
  );
}
