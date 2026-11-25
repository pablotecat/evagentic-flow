import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const optionalString = value => typeof value === 'string' && value.length ? value : null;
const optionalNumber = value => typeof value === 'number' && Number.isFinite(value) ? value : null;

const readLines = async file => {
  let text;
  try { text = await readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const rows = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index]) continue;
    try { rows.push(JSON.parse(lines[index])); }
    catch { throw new Error(`evaluation fixture line ${index + 1} is not valid JSON`); }
  }
  return rows;
};

const projectCriterion = row => ({
  id: optionalString(row?.id),
  title: optionalString(row?.title),
  weight: optionalNumber(row?.weight),
  mandatory: row?.mandatory === true,
  status: optionalString(row?.status),
  score: optionalNumber(row?.score),
  reason: optionalString(row?.reason),
  evidence: Array.isArray(row?.evidence) ? row.evidence.filter(item => typeof item === 'string') : [],
});

const projectRubricVersion = row => ({
  version: optionalString(row?.version),
  status: optionalString(row?.status),
  observedAt: optionalNumber(row?.observedAt),
  criteria: (Array.isArray(row?.criteria) ? row.criteria : []).map(projectCriterion),
  content: optionalString(row?.content),
});

const projectCoverage = row => row && typeof row === 'object'
  ? { evaluatedWeight: optionalNumber(row.evaluatedWeight),
    applicableWeight: optionalNumber(row.applicableWeight) } : null;

const ACCEPTANCE_VALUES = new Set(['accepted', 'rejected', 'pending']);

export function createEvaluationReader(fixturesDirectory = null) {
  if (typeof fixturesDirectory !== 'string' || !fixturesDirectory) {
    return {
      async rubrics() { return { source: 'none', state: 'ready', rubrics: [] }; },
      async evaluations() { return { source: 'none', state: 'ready', evaluations: [] }; },
    };
  }
  const reload = async (file, kind) => {
    let rows;
    try { rows = await readLines(join(fixturesDirectory, file)); }
    catch (error) { return { ok: false, reason: error.message }; }
    return { ok: true, rows };
  };
  return {
    async rubrics() {
      const read = await reload('rubrics.jsonl');
      if (!read.ok) return { source: 'synthetic-fixtures', state: 'read-error',
        reason: read.reason, rubrics: null };
      const grouped = new Map();
      for (const row of read.rows) {
        const rubricID = optionalString(row?.rubricID);
        if (!rubricID) continue;
        if (!grouped.has(rubricID)) grouped.set(rubricID, { rubricID, title: null, versions: [] });
        const rubric = grouped.get(rubricID);
        rubric.title ??= optionalString(row?.title);
        rubric.versions.push(projectRubricVersion(row));
      }
      return { source: 'synthetic-fixtures', state: 'ready', rubrics: [...grouped.values()] };
    },
    async evaluations(executionID) {
      const read = await reload('evaluations.jsonl');
      if (!read.ok) return { source: 'synthetic-fixtures', state: 'read-error',
        reason: read.reason, evaluations: null };
      const rubricRead = await reload('rubrics.jsonl');
      const evaluations = read.rows
        .filter(row => row?.executionID === executionID)
        .map(row => {
          const rubricID = optionalString(row?.rubric?.rubricID);
          const version = optionalString(row?.rubric?.version);
          const declared = rubricRead.ok
            ? (rubricRead.rows.find(item => optionalString(item?.rubricID) === rubricID
              && optionalString(item?.version) === version) ?? null) : null;
          const score = row?.score && typeof row.score === 'object'
            ? { value: optionalNumber(row.score.value), basis: optionalString(row.score.basis) } : null;
          return {
            evaluationID: optionalString(row?.evaluationID),
            executionID,
            captureID: optionalString(row?.captureID),
            captureReference: optionalString(row?.captureReference),
            reevaluationOf: optionalString(row?.reevaluationOf),
            evaluatedAt: optionalNumber(row?.evaluatedAt),
            rubric: { rubricID, version,
              status: declared ? optionalString(declared.status) : null,
              versionAvailable: declared !== null },
            versions: {
              component: optionalString(row?.versions?.component),
              case: optionalString(row?.versions?.case),
              rubric: optionalString(row?.versions?.rubric),
              evaluator: optionalString(row?.versions?.evaluator),
            },
            criteria: (Array.isArray(row?.criteria) ? row.criteria : []).map(projectCriterion),
            score: score && score.value !== null ? score : null,
            coverage: projectCoverage(row?.coverage),
            acceptance: ACCEPTANCE_VALUES.has(row?.acceptance) ? row.acceptance : null,
          };
        });
      return { source: 'synthetic-fixtures', state: 'ready', evaluations };
    },
  };
}
