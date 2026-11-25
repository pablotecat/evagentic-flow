import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const optionalString = value => typeof value === 'string' && value.length ? value : null;
const optionalNumber = value => typeof value === 'number' && Number.isFinite(value) ? value : null;

const MAX_FIXTURE_BYTES = 1024 * 1024;

const readLines = async file => {
  let text;
  try {
    if ((await stat(file)).size > MAX_FIXTURE_BYTES) throw new Error('evaluation fixture exceeds the size limit');
    text = await readFile(file, 'utf8');
  }
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

const versionKey = (rubricID, version) => `${rubricID}\u0000${version}`;

const evaluatedWeightMatches = (criteria, coverage) => {
  if (!coverage || coverage.evaluatedWeight === null) return null;
  const evaluated = criteria.filter(criterion => criterion.status === 'evaluated');
  if (!criteria.length || evaluated.some(criterion => criterion.weight === null)) return null;
  const sum = evaluated.reduce((total, criterion) => total + criterion.weight, 0);
  return Math.abs(sum - coverage.evaluatedWeight) < 1e-9;
};

const reevaluationState = (projected, byID) => {
  if (!projected.reevaluationOf) return null;
  const target = byID.get(projected.reevaluationOf);
  if (!target) return 'missing-target';
  const targetCapture = optionalString(target.captureID);
  if (!projected.captureID || !targetCapture) return 'unknown-capture';
  return projected.captureID === targetCapture ? 'same-capture' : 'different-capture';
};

export function createEvaluationReader(fixturesDirectory = null) {
  if (typeof fixturesDirectory !== 'string' || !fixturesDirectory) {
    return {
      async rubrics() { return { source: 'none', state: 'ready', rubrics: [] }; },
      async evaluations() { return { source: 'none', state: 'ready', evaluations: [] }; },
    };
  }
  const load = async file => {
    try { return { ok: true, rows: await readLines(join(fixturesDirectory, file)) }; }
    catch (error) { return { ok: false, reason: error.message }; }
  };
  const indexVersions = rows => {
    const index = new Map();
    for (const row of rows) {
      const rubricID = optionalString(row?.rubricID);
      if (!rubricID) continue;
      const key = versionKey(rubricID, optionalString(row?.version));
      index.set(key, [...index.get(key) ?? [], row]);
    }
    return index;
  };
  return {
    async rubrics() {
      const read = await load('rubrics.jsonl');
      if (!read.ok) return { source: 'synthetic-fixtures', state: 'read-error',
        reason: read.reason, rubrics: null };
      const grouped = new Map();
      let withoutRubricID = 0;
      for (const row of read.rows) {
        const rubricID = optionalString(row?.rubricID);
        if (!rubricID) { withoutRubricID++; continue; }
        if (!grouped.has(rubricID)) grouped.set(rubricID, { rubricID, title: null, versions: [] });
        const rubric = grouped.get(rubricID);
        rubric.title ??= optionalString(row?.title);
        rubric.versions.push(projectRubricVersion(row));
      }
      const duplicateVersions = [];
      for (const [key, rows] of indexVersions(read.rows)) {
        if (rows.length > 1) {
          const [rubricID, version] = key.split('\u0000');
          duplicateVersions.push({ rubricID, version: version === 'null' ? null : version });
        }
      }
      return { source: 'synthetic-fixtures', state: 'ready', rubrics: [...grouped.values()],
        anomalies: { withoutRubricID, duplicateVersions } };
    },
    async evaluations(executionID) {
      const read = await load('evaluations.jsonl');
      if (!read.ok) return { source: 'synthetic-fixtures', state: 'read-error',
        reason: read.reason, evaluations: null };
      const rubricRead = await load('rubrics.jsonl');
      const versions = rubricRead.ok ? indexVersions(rubricRead.rows) : null;
      const own = read.rows.filter(row => row?.executionID === executionID);
      const byID = new Map();
      for (const row of own) {
        const id = optionalString(row?.evaluationID);
        if (id && !byID.has(id)) byID.set(id, row);
      }
      const evaluations = own.map(row => {
        const rubricID = optionalString(row?.rubric?.rubricID);
        const version = optionalString(row?.rubric?.version);
        const matches = versions && rubricID ? versions.get(versionKey(rubricID, version)) ?? [] : [];
        const declared = matches.length === 1 ? matches[0] : null;
        const score = row?.score && typeof row.score === 'object'
          ? { value: optionalNumber(row.score.value), basis: optionalString(row.score.basis) } : null;
        const criteria = (Array.isArray(row?.criteria) ? row.criteria : []).map(projectCriterion);
        const coverage = projectCoverage(row?.coverage);
        const projected = {
          evaluationID: optionalString(row?.evaluationID),
          executionID,
          captureID: optionalString(row?.captureID),
          captureReference: optionalString(row?.captureReference),
          reevaluationOf: optionalString(row?.reevaluationOf),
          evaluatedAt: optionalNumber(row?.evaluatedAt),
          rubric: { rubricID, version,
            status: declared ? optionalString(declared.status) : null,
            versionAvailable: versions ? matches.length > 0 : null,
            versionAmbiguous: matches.length > 1,
            readError: rubricRead.ok ? null : rubricRead.reason },
          versions: {
            component: optionalString(row?.versions?.component),
            case: optionalString(row?.versions?.case),
            rubric: optionalString(row?.versions?.rubric),
            evaluator: optionalString(row?.versions?.evaluator),
          },
          criteria,
          score: score && score.value !== null ? score : null,
          coverage: coverage ? { ...coverage,
            evaluatedWeightMatches: evaluatedWeightMatches(criteria, coverage) } : null,
          acceptance: ACCEPTANCE_VALUES.has(row?.acceptance) ? row.acceptance : null,
        };
        projected.reevaluation = reevaluationState(projected, byID);
        return projected;
      });
      return { source: 'synthetic-fixtures', state: 'ready', evaluations };
    },
  };
}