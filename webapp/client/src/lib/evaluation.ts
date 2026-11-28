import type {
  Acceptance,
  EvaluationCriterionResult,
  EvaluationRecord,
  EvaluationRubricRef,
  ReevaluationState,
} from '../api/types';
import { uniqueKeys } from './trace';

export const ACCEPTANCE_LABELS: Record<Acceptance, string> = {
  accepted: 'aceptada',
  rejected: 'rechazada',
  pending: 'pendiente',
};

export const acceptanceLabel = (acceptance: Acceptance | null): string =>
  acceptance !== null && acceptance in ACCEPTANCE_LABELS
    ? ACCEPTANCE_LABELS[acceptance]
    : 'no declarada: desconocida; no se interpreta como aceptación';

export const acceptanceContradiction = (record: Pick<EvaluationRecord, 'acceptance' | 'criteria'>): boolean =>
  record.acceptance === 'accepted' && record.criteria.some(criterion => criterion.mandatory
    && (criterion.status !== 'evaluated' || criterion.evidence.length === 0));

export type RubricVersionStatusKind = 'approved' | 'draft' | 'unknown';

export type RubricReferenceStatusKind = RubricVersionStatusKind | 'read-error' | 'ambiguous';

export const RUBRIC_STATUS_BADGES: Record<RubricReferenceStatusKind, { tone: string; label: string }> = {
  approved: {
    tone: 'bg-emerald-100 text-emerald-900 ring-emerald-600/30 dark:bg-emerald-950 dark:text-emerald-200 dark:ring-emerald-400/30',
    label: 'Aprobada: versión aprobada explícitamente identificada',
  },
  draft: {
    tone: 'bg-amber-100 text-amber-900 ring-amber-600/30 dark:bg-amber-950 dark:text-amber-200 dark:ring-amber-400/30',
    label: 'Borrador: no es una versión aprobada',
  },
  unknown: {
    tone: 'bg-slate-100 text-slate-700 ring-slate-500/30 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-400/30',
    label: 'Desconocida: no se presenta como aprobada',
  },
  'read-error': {
    tone: 'bg-rose-100 text-rose-900 ring-rose-600/30 dark:bg-rose-950 dark:text-rose-200 dark:ring-rose-400/30',
    label: 'Error de lectura de rúbricas',
  },
  ambiguous: {
    tone: 'bg-amber-100 text-amber-900 ring-amber-600/30 dark:bg-amber-950 dark:text-amber-200 dark:ring-amber-400/30',
    label: 'Versión duplicada / ambigua',
  },
};

export const rubricVersionStatus = (status: string | null): RubricVersionStatusKind =>
  status === 'approved' ? 'approved' : status === 'draft' ? 'draft' : 'unknown';

export const resolveRubricReferenceStatus = (rubric: EvaluationRubricRef): RubricReferenceStatusKind => {
  if (rubric.readError) return 'read-error';
  if (rubric.versionAmbiguous) return 'ambiguous';
  if (rubric.versionAvailable === false) return 'unknown';
  return rubricVersionStatus(rubric.status);
};

export type CoverageCoherenceKind = 'coherent' | 'incoherent' | 'unverified';

export const COVERAGE_COHERENCE_LABELS: Record<CoverageCoherenceKind, string> = {
  coherent: 'El peso evaluado coincide con la suma de pesos de los criterios evaluados.',
  incoherent: 'Cobertura incoherente: el peso evaluado declarado no coincide con la suma de pesos de los criterios evaluados.',
  unverified: 'Coherencia de la cobertura no verificada: faltan datos para comprobarla.',
};

export const coverageCoherence = (
  record: Pick<EvaluationRecord, 'criteria' | 'coverage'>,
): CoverageCoherenceKind | null => {
  const coverage = record.coverage;
  if (coverage === null) return null;
  if (typeof coverage.evaluatedWeightMatches === 'boolean') {
    return coverage.evaluatedWeightMatches ? 'coherent' : 'incoherent';
  }
  if (coverage.evaluatedWeight === null) return 'unverified';
  const evaluated = record.criteria.filter(criterion => criterion.status === 'evaluated');
  if (record.criteria.length === 0 || evaluated.some(criterion => criterion.weight === null)) {
    return 'unverified';
  }
  const sum = evaluated.reduce((total, criterion) => total + (criterion.weight ?? 0), 0);
  return Math.abs(sum - coverage.evaluatedWeight) < 1e-9 ? 'coherent' : 'incoherent';
};

export const REEVALUATION_TEXT: Record<ReevaluationState, (of: string) => string> = {
  'same-capture': of => `Es una reevaluación de ${of} sobre la misma captura: conserva sus propios resultados y no es otra ejecución del flujo.`,
  'different-capture': of => `Declara reevaluar ${of}, pero la captura no coincide: no se presenta como reevaluación sobre la misma captura; conserva sus propios resultados y no es otra ejecución del flujo.`,
  'missing-target': of => `Declara reevaluar ${of}, que no existe entre las evaluaciones de esta ejecución: referencia no resoluble; conserva sus propios resultados y no es otra ejecución del flujo.`,
  'unknown-capture': of => `Declara reevaluar ${of}, pero no se puede comprobar que sea la misma captura; conserva sus propios resultados y no es otra ejecución del flujo.`,
};

export const resolveReevaluation = (
  record: Pick<EvaluationRecord, 'reevaluationOf' | 'captureID' | 'reevaluation'>,
  byID: Map<string, EvaluationRecord>,
): ReevaluationState | null => {
  if (record.reevaluationOf === null) return null;
  if (record.reevaluation !== null && record.reevaluation !== undefined) return record.reevaluation;
  const target = byID.get(record.reevaluationOf);
  if (target === undefined) return 'missing-target';
  if (record.captureID === null || target.captureID === null) return 'unknown-capture';
  return record.captureID === target.captureID ? 'same-capture' : 'different-capture';
};

export type EvaluationGroup = {
  key: string;
  original: EvaluationRecord;
  items: EvaluationRecord[];
};

const resolveGroupRoot = (
  record: EvaluationRecord,
  byID: Map<string, EvaluationRecord>,
): EvaluationRecord => {
  const visited = new Set<EvaluationRecord>([record]);
  let current = record;
  while (current.reevaluationOf !== null) {
    if (resolveReevaluation(current, byID) !== 'same-capture') break;
    const target = byID.get(current.reevaluationOf);
    if (target === undefined) break;
    if (visited.has(target)) return record;
    visited.add(target);
    current = target;
  }
  return current;
};

export const groupEvaluations = (evaluations: EvaluationRecord[]): EvaluationGroup[] => {
  const byID = new Map<string, EvaluationRecord>();
  for (const record of evaluations) {
    if (record.evaluationID !== null && !byID.has(record.evaluationID)) byID.set(record.evaluationID, record);
  }
  const groups: EvaluationGroup[] = [];
  const groupByRoot = new Map<EvaluationRecord, EvaluationGroup>();
  for (const record of evaluations) {
    const root = resolveGroupRoot(record, byID);
    let group = groupByRoot.get(root);
    if (group === undefined) {
      group = {
        key: root.evaluationID ?? `sin-identidad-${groups.length}`,
        original: root,
        items: [],
      };
      groups.push(group);
      groupByRoot.set(root, group);
    }
    group.items.push(record);
  }
  const keys = uniqueKeys(groups, group => group.key);
  return groups.map((group, index) => ({ ...group, key: keys[index] }));
};

export const duplicateEvaluationIDs = (evaluations: EvaluationRecord[]): string[] => {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const record of evaluations) {
    if (record.evaluationID === null) continue;
    if (seen.has(record.evaluationID)) repeated.add(record.evaluationID);
    else seen.add(record.evaluationID);
  }
  return [...repeated];
};

export type CriterionResultKind = 'evaluated' | 'not-evaluable' | 'unknown';

export const criterionResult = (criterion: EvaluationCriterionResult): { kind: CriterionResultKind; label: string } => {
  if (criterion.status === 'not-evaluable') {
    return { kind: 'not-evaluable', label: `no evaluable: ${criterion.reason ?? 'motivo no declarado'}` };
  }
  if (criterion.status === 'evaluated') {
    if (criterion.score !== null) {
      return { kind: 'evaluated', label: `Evaluado · puntuación ${criterion.score}` };
    }
    return { kind: 'evaluated', label: 'Evaluado · puntuación desconocida' };
  }
  if (criterion.score !== null) {
    return { kind: 'evaluated', label: `Puntuación ${criterion.score}` };
  }
  return { kind: 'unknown', label: 'Desconocido' };
};
