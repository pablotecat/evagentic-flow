import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const reader = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'inspect.mjs');
const ENTRY = 'session.inbox.enqueued';
const RESPONSE = 'session.text.ended';
const EXECUTION_PREFIX = 'session.execution.';
const cache = new Map();
const pendingReads = new Map();
const TTL = 700;
const READER_TIMEOUT = 20000;
const READER_MAX_OUTPUT = 64 * 1024 * 1024;
const READER_MAX_ERRORS = 4096;

export function latestLifecycle(rows) {
  const events = rows.filter(row => row.type?.startsWith(EXECUTION_PREFIX));
  if (!events.length || events.some(row => row.sourceSequence === null
    || row.sourceAggregateID !== events[0].sourceAggregateID)) return null;
  return events.reduce((latest, row) => row.sourceSequence > latest.sourceSequence ? row : latest).lifecycle?.phase;
}

const runReader = (captureDirectory, args) => new Promise(resolve => {
  const child = spawn(process.execPath, [reader, captureDirectory, ...args]);
  let output = '';
  let errors = '';
  let settled = false;
  const finish = value => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(value);
  };
  const abort = reason => {
    child.kill();
    finish({ ok: false, reason });
  };
  const timer = setTimeout(() => abort('reader-timeout'), READER_TIMEOUT);
  child.stdout.setEncoding('utf8').on('data', chunk => {
    output += chunk;
    if (output.length > READER_MAX_OUTPUT) abort('reader-output-too-large');
  });
  child.stderr.setEncoding('utf8').on('data', chunk => {
    if (errors.length < READER_MAX_ERRORS) errors += chunk;
  });
  child.on('error', error => finish({ ok: false, reason: error.message }));
  child.on('close', code => {
    if (code !== 0) return finish({ ok: false, reason: errors.trim() || `reader exited with ${code}` });
    const rows = [];
    const lines = output.split('\n');
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index]) continue;
      try { rows.push(JSON.parse(lines[index])); }
      catch { return finish({ ok: false, reason: `invalid-reader-line:${index + 1}` }); }
    }
    finish({ ok: true, rows });
  });
});

const runCached = async (captureDirectory, args) => {
  const key = JSON.stringify([captureDirectory, ...args]);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < TTL) return cached.value;
  const inFlight = pendingReads.get(key);
  if (inFlight) return inFlight;
  if (cache.size > 50) cache.clear();
  const read = runReader(captureDirectory, args).then(value => {
    cache.set(key, { at: Date.now(), value });
    return value;
  }).finally(() => pendingReads.delete(key));
  pendingReads.set(key, read);
  return read;
};

const sessionTree = (rows, rootSessionID) => {
  const sessionIDs = new Set([rootSessionID]);
  for (let size = -1; size !== sessionIDs.size;) {
    size = sessionIDs.size;
    for (const row of rows) {
      if (row.sessionID && sessionIDs.has(row.parentSessionID)) sessionIDs.add(row.sessionID);
      if (row.childSessionID && sessionIDs.has(row.sessionID)) sessionIDs.add(row.childSessionID);
    }
  }
  const scoped = rows.filter(row => sessionIDs.has(row.sessionID));
  const lastObserved = scoped.reduce((latest, row) =>
    latest === null || row.observedAt > latest ? row.observedAt : latest, null);
  return { sessionIDs, scoped,
    horizon: lastObserved === null ? null : new Date(lastObserved).toISOString() };
};
export async function readRows(captureDirectory, sessionID = null) {
  return runCached(captureDirectory, sessionID ? [sessionID] : []);
}

const readMode = (captureDirectory, sessionID, mode) => runCached(captureDirectory, [sessionID, mode]);

export async function readSession(captureDirectory, sessionID) {
  const read = await readRows(captureDirectory);
  if (!read.ok) return { ok: false, reason: read.reason };
  const rows = read.rows.filter(row => row.sessionID === sessionID);
  const { sessionIDs, scoped, horizon } = sessionTree(read.rows, sessionID);
  const reference = row => ({ captureID: row.captureID, arrival: row.arrival, observedAt: row.observedAt });
  const interactionKey = row =>
    `${row.sessionID}\u0000${row.interaction.kind}\u0000${row.interaction.requestID}`;
  const resolvedKeys = new Set();
  for (const row of scoped) {
    if (row.interaction?.requestID && row.interaction.phase !== 'requested') resolvedKeys.add(interactionKey(row));
  }
  const requests = new Map();
  const resolved = [];
  const identity = entry => `${entry.sessionID}\u0000${entry.kind}\u0000${entry.requestID}`;
  for (const row of scoped) {
    const interaction = row.interaction;
    if (!interaction?.requestID) continue;
    const entry = {
      kind: interaction.kind,
      sessionID: row.sessionID,
      requestID: interaction.requestID,
      request: interaction.request ?? null,
      observedAt: row.observedAt,
    };
    if (interaction.phase !== 'requested') resolved.push({ ...entry,
      phase: interaction.phase, response: interaction.response ?? null });
    else requests.set(identity(entry), entry);
  }
  for (const entry of resolved) entry.request = requests.get(identity(entry))?.request ?? entry.request;
  const pending = [...requests.entries()]
    .filter(([key]) => !resolvedKeys.has(key))
    .map(([, entry]) => entry);
  return {
    ok: true,
    rows: read.rows,
    admission: rows.find(row => row.type === ENTRY && row.messageID),
    entries: rows.filter(row => row.type === ENTRY && row.content?.role === 'user')
      .map(row => ({ text: row.content.text })),
    responses: rows.filter(row => row.type === RESPONSE && row.content?.role === 'assistant')
      .map(row => ({ text: row.content.text })),
    captureIDs: [...new Set(scoped.map(row => row.captureID).filter(Boolean))],
    recorderFailed: read.rows.some(row => row.type === 'recorder.failed'),
    scope: { kind: 'observed-session-tree', rootSessionID: sessionID, sessionIDs: [...sessionIDs] },
    gaps: read.rows.filter(row => row.type === 'recorder.gap')
      .map(row => ({ ...reference(row), scope: 'capture', reason: row.reason })),
    omissions: scoped.filter(row => row.omissions?.length)
      .map(row => ({ ...reference(row), sessionID: row.sessionID, type: row.type, omissions: row.omissions })),
    horizon,
    interactions: { pending, resolved },
  };
}

const OBSERVATION_STAGES = {
  admitted: 'admitted-skill',
  available: 'availability',
  runtimeDefinition: 'runtime-definition',
  deployedFile: 'deployed-file',
  environment: 'environment',
};
const TRACE_MODES = ['--tree', '--tools', '--metrics', '--coverage'];

const traceNodes = (scoped, sessionIDs, selectedSessionID, reference) => [...sessionIDs].map(sessionID => {
  const sessionRows = scoped.filter(row => row.sessionID === sessionID);
  const present = value => value !== null && value !== undefined;
  const agentIDs = [...new Set(sessionRows.map(row => row.agentID).filter(present))];
  const observedParents = [...new Set(sessionRows.map(row => row.parentSessionID).filter(present))];
  const delegations = scoped.filter(row => row.childSessionID === sessionID)
    .map(row => ({ parentSessionID: row.sessionID, callID: row.callID ?? null,
      evidence: { ...reference(row), type: row.type } }));
  return {
    sessionID,
    isViewRoot: sessionID === selectedSessionID,
    agentIDs,
    observedParents,
    delegations,
    relation: sessionID === selectedSessionID ? 'view-root'
      : delegations.length ? 'delegation-call-observed'
      : observedParents.length ? 'parent-observed-call-unknown' : 'unknown',
  };
});

const traceSkills = (scoped, reference) => {
  const observation = stage => scoped
    .filter(row => row.type === 'recorder.observation' && row.stage === stage)
    .map(row => ({ observationTime: row.observationTime, source: row.source,
      identity: row.identity ?? null, sessionID: row.sessionID, messageID: row.messageID ?? null,
      eventID: row.eventID ?? null, status: row.status, omissions: row.omissions,
      redactions: row.redactions, value: row.value, sha256: row.sha256 ?? null,
      hashBasis: row.hashBasis, evidence: reference(row) }));
  return {
    observed: scoped.filter(row => row.skill)
      .map(row => ({ sessionID: row.sessionID, messageID: row.messageID ?? null,
        callID: row.callID ?? null, type: row.type, skill: row.skill, evidence: reference(row) })),
    admitted: observation(OBSERVATION_STAGES.admitted),
    available: observation(OBSERVATION_STAGES.available),
    definitions: [...observation(OBSERVATION_STAGES.runtimeDefinition),
      ...observation(OBSERVATION_STAGES.deployedFile)],
    environment: observation(OBSERVATION_STAGES.environment),
  };
};

const traceDiagnostics = (metrics, tools, coverage) => {
  const ofType = type => metrics.rows.filter(row => row.type === type);
  return {
    timeline: { intervals: ofType('diagnostic.execution-interval'), waits: ofType('diagnostic.wait') },
    tools: { attempts: tools.rows },
    metrics: {
      steps: ofType('diagnostic.model-step'),
      measurements: ofType('diagnostic.measurement'),
      pendingInbox: ofType('diagnostic.pending-inbox'),
      coverage: metrics.rows.find(row => row.type === 'diagnostic.metric-coverage') ?? null,
    },
    captureDiagnostics: coverage.rows.find(row => row.type === 'diagnostic.capture-coverage') ?? null,
  };
};

export async function readTrace(captureDirectory, rootSessionID, requestedSessionID = null) {
  const selectedSessionID = requestedSessionID || rootSessionID;
  if (selectedSessionID.startsWith('--')) return { ok: false, notInExecution: true };
  const session = await readSession(captureDirectory, rootSessionID);
  if (!session.ok) return { ok: false, reason: session.reason };
  if (selectedSessionID !== rootSessionID && !session.scope.sessionIDs.includes(selectedSessionID)) {
    return { ok: false, notInExecution: true };
  }
  const reads = await Promise.all(TRACE_MODES.map(mode => readMode(captureDirectory, selectedSessionID, mode)));
  for (const read of reads) {
    if (!read.ok) return { ok: false, reason: read.reason };
  }
  const [tree, tools, metrics, coverage] = reads;
  const { sessionIDs, scoped, horizon } = sessionTree(tree.rows, selectedSessionID);
  const reference = row => ({ captureID: row.captureID, arrival: row.arrival, eventID: row.eventID ?? null });
  return {
    ok: true,
    readable: true,
    selectedSessionID,
    tree: { nodes: traceNodes(scoped, sessionIDs, selectedSessionID, reference),
      sessionIDs: [...sessionIDs] },
    ...traceDiagnostics(metrics, tools, coverage),
    skills: traceSkills(scoped, reference),
    horizon,
  };
}