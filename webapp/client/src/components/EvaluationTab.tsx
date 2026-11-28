import { useMemo } from 'react';
import type { Execution, EvaluationRecord } from '../api/types';
import { useEvaluations } from '../hooks/useEvaluations';
import {
  COVERAGE_COHERENCE_LABELS,
  RUBRIC_STATUS_BADGES,
  REEVALUATION_TEXT,
  acceptanceContradiction,
  acceptanceLabel,
  coverageCoherence,
  criterionResult,
  duplicateEvaluationIDs,
  groupEvaluations,
  resolveReevaluation,
  resolveRubricReferenceStatus,
  type CriterionResultKind,
  type EvaluationGroup,
} from '../lib/evaluation';
import { isoOrUnobserved } from '../lib/trace';
import { alertClass, badgeClass, chipClass, mandatoryBadgeClass, noticeClass } from '../lib/ui';
import { CopyButton } from './CopyButton';

const criterionResultTone: Record<CriterionResultKind, string> = {
  evaluated: 'bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200',
  'not-evaluable': 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  unknown: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
};

const acceptanceTone: Record<string, string> = {
  accepted: 'bg-emerald-100 text-emerald-900 ring-emerald-600/30 dark:bg-emerald-950 dark:text-emerald-200 dark:ring-emerald-400/30',
  contradiction: 'bg-rose-100 text-rose-900 ring-rose-600/30 dark:bg-rose-950 dark:text-rose-200 dark:ring-rose-400/30',
  rejected: 'bg-red-100 text-red-900 ring-red-600/30 dark:bg-red-950 dark:text-red-200 dark:ring-red-400/30',
  pending: 'bg-amber-100 text-amber-900 ring-amber-600/30 dark:bg-amber-950 dark:text-amber-200 dark:ring-amber-400/30',
  unknown: 'bg-slate-100 text-slate-700 ring-slate-500/30 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-400/30',
};

type Props = { execution: Execution };

export function EvaluationTab({ execution }: Props) {
  const { body } = useEvaluations(execution.id);
  const byID = useMemo(() => {
    const map = new Map<string, EvaluationRecord>();
    if (body !== null && body.state === 'ready') {
      for (const record of body.evaluations) {
        if (record.evaluationID !== null && !map.has(record.evaluationID)) map.set(record.evaluationID, record);
      }
    }
    return map;
  }, [body]);
  if (body === null) {
    return (
      <p data-evaluations-loading className={noticeClass}>
        Consultando si existen resultados de evaluación de esta captura…
      </p>
    );
  }
  if (body.state === 'read-error') {
    return (
      <p data-evaluations-unreadable role="alert" className={alertClass}>
        Los resultados de evaluación no están consultables ({body.reason ?? 'desconocido'}); no se muestran
        puntuaciones ni aceptación inventadas.
      </p>
    );
  }
  if (body.evaluations.length === 0) {
    return (
      <div data-evaluation-empty className="rounded-xl border border-slate-200 bg-white/60 p-4 dark:border-slate-800 dark:bg-slate-900/50">
        <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Sin evaluación</h3>
        <p className={`${noticeClass} mt-1`}>
          No existe ningún resultado de evaluación para esta ejecución; la finalización técnica no equivale a una
          aceptación y no se generan puntuaciones, versiones ni aceptaciones de ejemplo.
        </p>
      </div>
    );
  }
  const groups = groupEvaluations(body.evaluations);
  const duplicates = duplicateEvaluationIDs(body.evaluations);
  return (
    <div className="space-y-4">
      <p className={noticeClass}>
        Resultados de sólo lectura, separados de la traza y de los diagnósticos técnicos. Cada evaluación conserva
        la versión exacta de rúbrica que aplicó y sus resultados por criterio.
      </p>
      {duplicates.map(id => (
        <p key={id} role="alert" data-anomaly="evaluacion-duplicada" className={alertClass}>
          Identidad de evaluación repetida: {id} aparece en varios resultados; no se consolidan ni se descartan,
          porque cada fila es un resultado conservado por separado.
        </p>
      ))}
      {groups.map(group => (
        <EvaluationGroupSection key={group.key} group={group} byID={byID} />
      ))}
      <p className={noticeClass}>
        Varias evaluaciones de la misma captura conservan su identidad y sus resultados por separado; una
        reevaluación no es otra ejecución del flujo y no sobrescribe a la anterior. No existen acciones de evaluar,
        reevaluar o editar rúbricas en esta entrega.
      </p>
    </div>
  );
}

function EvaluationGroupSection({ group, byID }: { group: EvaluationGroup; byID: Map<string, EvaluationRecord> }) {
  const original = group.original;
  return (
    <section
      data-evaluation-group={group.key}
      aria-label={`Resultados de la evaluación ${group.original.evaluationID ?? 'sin identidad'}`}
      className="space-y-3 rounded-xl border border-slate-200 bg-white/60 p-3 dark:border-slate-800 dark:bg-slate-900/50"
    >
      {group.items.length > 1 ? (
        <p data-evaluation-group-count className={noticeClass}>
          Evaluación {original.evaluationID ?? 'sin identidad'} y sus reevaluaciones ({group.items.length}
          {' '}resultados): cada una conserva su identidad, su captura y sus resultados por separado; una
          reevaluación no es otra ejecución del flujo.
        </p>
      ) : null}
      {group.items.map((record, index) => (
        <EvaluationCard key={`${record.evaluationID ?? 'sin-identidad'}-${index}`} record={record} byID={byID} />
      ))}
    </section>
  );
}

function EvaluationCard({ record, byID }: { record: EvaluationRecord; byID: Map<string, EvaluationRecord> }) {
  const reevaluation = resolveReevaluation(record, byID);
  const contradiction = acceptanceContradiction(record);
  const coherence = coverageCoherence(record);
  const acceptanceKey = contradiction ? 'contradiction' : (record.acceptance ?? 'unknown');
  const coverageRatio = record.coverage !== null
    && record.coverage.evaluatedWeight !== null
    && record.coverage.applicableWeight !== null
    && record.coverage.applicableWeight > 0
    && record.coverage.evaluatedWeight >= 0
    ? Math.max(0, Math.min(record.coverage.evaluatedWeight / record.coverage.applicableWeight, 1))
    : null;
  return (
    <article data-evaluation={record.evaluationID ?? ''} className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
          Evaluación <span className="font-mono text-xs break-all font-normal">{record.evaluationID ?? 'de identidad desconocida'}</span>
        </h3>
        {record.evaluationID !== null ? <CopyButton label="Copiar evaluación" value={record.evaluationID} /> : null}
        {record.reevaluationOf !== null ? (
          <span data-reevaluation className={chipClass}>Reevaluación de {record.reevaluationOf}</span>
        ) : null}
        <span data-acceptance={acceptanceKey} className={`${badgeClass} ${acceptanceTone[acceptanceKey]}`}>
          {contradiction
            ? 'Aceptación: aceptada (en contradicción · pendiente por evidencia obligatoria)'
            : `Aceptación: ${acceptanceLabel(record.acceptance)}`}
        </span>
      </header>
      {contradiction ? (
        <p role="alert" data-contradiction="acceptance" className={alertClass}>
          Contradicción: la evaluación declara aceptación, pero un criterio obligatorio no es evaluable o carece de
          evidencia. Decisión pendiente por falta de evidencia obligatoria: no se presenta como aceptación firme.
        </p>
      ) : null}
      <div className="space-y-1">
        {record.score !== null ? (
          <p data-score>
            {record.score.basis === 'criterios-evaluados'
              ? `Puntuación sobre los criterios evaluados: ${record.score.value}`
              : `Puntuación sin base declarada como criterios evaluados: ${record.score.value} (base: ${record.score.basis ?? 'no declarada'})`}
          </p>
        ) : (
          <p data-score className={noticeClass}>Puntuación: desconocida; no se transforma en cero</p>
        )}
        {record.coverage !== null ? (
          <p data-coverage>
            Cobertura de evaluación: {record.coverage.evaluatedWeight ?? 'desconocido'} de {record.coverage.applicableWeight ?? 'desconocido'} de peso de criterios aplicables
          </p>
        ) : (
          <p data-coverage className={noticeClass}>Cobertura de evaluación: desconocida</p>
        )}
        {coverageRatio !== null ? (
          <div data-coverage-bar className="h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
            <div className="h-full rounded-full bg-emerald-500" style={{ width: `${coverageRatio * 100}%` }} />
          </div>
        ) : null}
        {coherence !== null ? (
          <p
            data-coverage-coherence={coherence}
            role={coherence === 'incoherent' ? 'alert' : undefined}
            className={coherence === 'incoherent' ? alertClass : noticeClass}
          >
            {COVERAGE_COHERENCE_LABELS[coherence]}
          </p>
        ) : null}
      </div>
      <RubricReference record={record} />
      <ul className={`${noticeClass} space-y-0.5`}>
        <li>Versión de componente: {record.versions.component ?? 'desconocida'}</li>
        <li>Versión de caso: {record.versions.case ?? 'desconocida'}</li>
        <li>Versión de rúbrica: {record.versions.rubric ?? 'desconocida'}</li>
        <li>Versión de evaluador: {record.versions.evaluator ?? 'desconocida'}</li>
      </ul>
      <div className="space-y-1">
        <p className={noticeClass}>Evaluada: {isoOrUnobserved(record.evaluatedAt)}</p>
        <p className={noticeClass}>
          Captura:{' '}
          {record.captureID !== null ? (
            <>
              <span className="font-mono text-xs break-all">{record.captureID}</span>
              <CopyButton label="Copiar captura" value={record.captureID} className="ml-1" />
            </>
          ) : 'referencia no declarada'}
          {' '}({record.captureReference ?? 'detalle no disponible'})
        </p>
      </div>
      <CriteriaTable record={record} />
      {reevaluation !== null ? (
        <p
          data-reevaluation={reevaluation}
          role={reevaluation === 'same-capture' ? undefined : 'alert'}
          className={reevaluation === 'same-capture' ? noticeClass : alertClass}
        >
          {REEVALUATION_TEXT[reevaluation](record.reevaluationOf ?? 'referencia no declarada')}
        </p>
      ) : null}
    </article>
  );
}

function RubricReference({ record }: { record: EvaluationRecord }) {
  const rubric = record.rubric;
  const status = resolveRubricReferenceStatus(rubric);
  return (
    <div data-rubric-reference className="space-y-1">
      <p>
        Rúbrica aplicada:{' '}
        <span className="font-mono text-xs break-all">{rubric.rubricID ?? 'desconocida'}</span>
        {' '}· Versión{' '}
        {rubric.version !== null ? (
          <>
            <span className="font-mono text-xs break-all">{rubric.version}</span>
            {rubric.rubricID !== null ? <CopyButton label="Copiar versión de rúbrica" value={`${rubric.rubricID}@${rubric.version}`} className="ml-1" /> : null}
          </>
        ) : 'desconocida'}
      </p>
      <span data-rubric-status={status} className={`${badgeClass} ${RUBRIC_STATUS_BADGES[status].tone}`}>
        {RUBRIC_STATUS_BADGES[status].label}
      </span>
      {rubric.readError ? (
        <p role="alert" data-rubric-read-error={rubric.readError} className={alertClass}>
          No se pudo leer la vista de rúbricas ({rubric.readError}); la disponibilidad de esta versión es
          desconocida y no se confunde con una versión ausente.
        </p>
      ) : rubric.versionAmbiguous ? (
        <p role="alert" data-rubric-ambiguous className={alertClass}>
          La versión de rúbrica aparece duplicada en la vista de rúbricas: su estado no se resuelve.
        </p>
      ) : rubric.versionAvailable === false ? (
        <p className={noticeClass}>
          Referencia exacta conservada desde la evaluación; el contenido de esa versión no está disponible en la
          vista de rúbricas.
        </p>
      ) : null}
    </div>
  );
}

function CriteriaTable({ record }: { record: EvaluationRecord }) {
  if (record.criteria.length === 0) {
    return <p className={noticeClass}>Sin criterios declarados en este resultado.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table data-criteria-table className="w-full min-w-[560px] border-collapse text-xs">
        <thead>
          <tr className="border-b border-slate-200 text-left text-slate-500 dark:border-slate-700 dark:text-slate-400">
            <th scope="col" className="py-1 pr-3 font-medium">Criterio</th>
            <th scope="col" className="py-1 pr-3 font-medium">Carácter</th>
            <th scope="col" className="py-1 pr-3 font-medium">Resultado</th>
            <th scope="col" className="py-1 pr-3 font-medium">Peso</th>
            <th scope="col" className="py-1 pr-3 font-medium">Motivo</th>
            <th scope="col" className="py-1 font-medium">Evidencia</th>
          </tr>
        </thead>
        <tbody>
          {record.criteria.map((criterion, index) => {
            const result = criterionResult(criterion);
            const evidence = criterion.evidence.join(' | ');
            return (
              <tr key={index} data-criterion={criterion.id ?? ''} className="border-b border-slate-100 align-top dark:border-slate-800">
                <td className="py-1.5 pr-3">{criterion.id ?? 'desconocido'} — {criterion.title ?? 'título no disponible'}</td>
                <td className="py-1.5 pr-3">
                  {criterion.mandatory ? (
                    <span data-mandatory-badge className={mandatoryBadgeClass}>Obligatorio</span>
                  ) : (
                    <span className={noticeClass}>no obligatorio</span>
                  )}
                </td>
                <td className="py-1.5 pr-3">
                  <span data-criterion-result={result.kind} className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${criterionResultTone[result.kind]}`}>
                    {result.label}
                  </span>
                </td>
                <td className="py-1.5 pr-3">{criterion.weight ?? 'desconocido'}</td>
                <td className="py-1.5 pr-3">{criterion.reason ?? 'motivo no declarado'}</td>
                <td className="py-1.5">
                  {criterion.evidence.length > 0 ? (
                    <>
                      <code className="font-mono text-[11px] break-all">{evidence}</code>
                      <CopyButton label="Copiar evidencia" value={evidence} className="ml-1" />
                    </>
                  ) : (
                    <span className={noticeClass}>sin evidencia</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
