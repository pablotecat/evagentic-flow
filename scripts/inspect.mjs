import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

// Independent consumer of capture v1: no plugin imports, database or running OpenCode.
const common = ['schemaVersion', 'captureID', 'arrival', 'observedAt', 'type'];
const exactKeys = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const strings = value => Array.isArray(value) && value.every(item => typeof item === 'string');
const identifier = value => value === null || (typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value));
const nullableInteger = (value, minimum) => value === null || (Number.isSafeInteger(value) && value >= minimum);
const relations = ['parentSessionID', 'agentID', 'sessionObservedAt', 'callID', 'toolName', 'childSessionID'];
const toolName = value => value === null || (typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(value));
const json = value => value === null || typeof value === 'string' || typeof value === 'boolean'
  || (typeof value === 'number' && Number.isFinite(value)) || (Array.isArray(value) ? value.every(json)
    : typeof value === 'object' && Object.values(value).every(json));
const validTool = tool => tool === null || (exactKeys(tool, ['input', 'inputText', 'output', 'error',
  'outcome', 'executed', 'reportedError', 'retryOf', 'operationID', 'consumption'])
  && json(tool.input) && (tool.inputText === null || typeof tool.inputText === 'string')
  && (tool.output === null || (Array.isArray(tool.output) && tool.output.every(part => exactKeys(part, ['type', 'text'])
    && part.type === 'text' && typeof part.text === 'string')))
  && (tool.error === null || (exactKeys(tool.error, ['type', 'message', ...(Object.hasOwn(tool.error, 'status') ? ['status'] : [])])
    && typeof tool.error.type === 'string' && typeof tool.error.message === 'string'
    && (!Object.hasOwn(tool.error, 'status') || (Number.isInteger(tool.error.status) && tool.error.status >= 100 && tool.error.status <= 599))))
  && ['not-observed', 'success', 'error'].includes(tool.outcome)
  && [tool.executed, tool.reportedError].every(value => value === null || typeof value === 'boolean')
  && tool.retryOf === null && tool.operationID === null && tool.consumption === null);
const validInteraction = value => value === null || (exactKeys(value, ['kind', 'requestID', 'phase', 'origin',
  'relationSource', 'request', 'response']) && ['permission', 'form'].includes(value.kind) && identifier(value.requestID)
  && ['requested', 'replied', 'cancelled'].includes(value.phase)
  && ['runtime-request', 'external-reply-unattributed', 'runtime-cancellation'].includes(value.origin)
  && [null, 'permission-source', 'permission-request-event', 'form-question-metadata', 'form-request-event'].includes(value.relationSource)
  && json(value.request) && json(value.response));
const validRetry = retry => retry === null || (exactKeys(retry, ['kind', 'attempt', 'at', 'error'])
  && retry.kind === 'model' && Number.isSafeInteger(retry.attempt) && retry.attempt >= 1
  && Number.isSafeInteger(retry.at) && retry.at >= 0
  && exactKeys(retry.error, ['type', 'message', ...(Object.hasOwn(retry.error, 'status') ? ['status'] : [])])
  && typeof retry.error.type === 'string' && typeof retry.error.message === 'string'
  && (!Object.hasOwn(retry.error, 'status') || (Number.isInteger(retry.error.status) && retry.error.status >= 100 && retry.error.status <= 599)));
const validSkill = skill => skill === null || (exactKeys(skill, ['id', 'name', 'text', 'sha256', 'origin', 'contextID', 'consumption'])
  && toolName(skill.id) && (skill.name === null || typeof skill.name === 'string') && typeof skill.text === 'string'
  && ['successful-skill-tool-result', 'runtime-activation-event'].includes(skill.origin)
  && skill.sha256 === digest(skill.text) && skill.contextID === null && skill.consumption === null);
const digest = text => createHash('sha256').update(text, 'utf8').digest('hex');

function validRecord(row) {
  if (row?.schemaVersion !== 1 || typeof row.captureID !== 'string'
    || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(row.captureID)
    || !Number.isSafeInteger(row.arrival) || row.arrival < 1 || !Number.isFinite(row.observedAt)
    || typeof row.type !== 'string') return false;
  if (row.type === 'recorder.ready') {
    const observation = Object.hasOwn(row, 'observationVersion');
    return exactKeys(row, [...common, 'runtimeVersion', 'sdkVersion', 'coverage',
      ...observation ? ['observationVersion', 'recorderVersion', 'versionSources'] : []])
      && typeof row.runtimeVersion === 'string' && (typeof row.sdkVersion === 'string' || (observation && row.sdkVersion === null))
      && (!observation || (row.observationVersion === 1 && (row.recorderVersion === null || typeof row.recorderVersion === 'string')
        && exactKeys(row.versionSources, ['runtime', 'sdk', 'recorder', 'hostSdk'])
        && row.versionSources.runtime === 'ctx.app.version' && row.versionSources.hostSdk === null
        && ['resolved-package-manifest', 'unknown'].includes(row.versionSources.sdk)
        && ['recorder-package-manifest', 'unknown'].includes(row.versionSources.recorder)))
      && exactKeys(row.coverage, ['replay', 'content', 'excluded', 'executionID', 'ordering'])
      && row.coverage.replay === false && strings(row.coverage.content) && strings(row.coverage.excluded)
      && row.coverage.executionID === 'not-exposed' && row.coverage.ordering === 'arrival-is-not-causality';
  }
  if (row.type === 'recorder.observation') {
    const sources = {
      availability: ['opencode.skill.list'], 'deployed-file': ['node.fs.readFile'],
      'runtime-definition': ['opencode.skill.list', 'opencode.agent.get'],
      'context-hook': ['context', 'compaction', 'generate', 'title'].map(name => `opencode.session.hook.${name}`),
      environment: ['opencode.plugin.list'], 'admitted-skill': ['opencode.session.inbox.skills'],
    };
    return exactKeys(row, [...common, 'observationVersion', 'stage', 'source', 'identity', 'observationTime',
      'requestObservationID', 'projectID', 'sessionID', 'executionID', 'messageID', 'eventID', 'value', 'sha256',
      'hashBasis', 'status', 'omissions', 'redactions']) && row.observationVersion === 1
      && sources[row.stage]?.includes(row.source) && (row.identity === null || typeof row.identity === 'string')
      && Number.isFinite(row.observationTime) && ['requestObservationID', 'projectID', 'sessionID', 'messageID', 'eventID']
        .every(key => identifier(row[key])) && row.executionID === null && row.hashBasis === 'redacted-json-utf8'
      && json(row.value) && strings(row.omissions) && strings(row.redactions)
      && (row.status === 'captured' ? row.sha256 === digest(JSON.stringify(row.value))
        : row.status === 'unrecognized' && row.value === null && row.sha256 === null);
  }
  if (row.type === 'recorder.failed' || row.type === 'recorder.gap') {
    return exactKeys(row, [...common, 'reason']) && row.reason === (row.type === 'recorder.failed'
      ? 'event-stream-or-persistence-failure' : 'unrecognized-session-envelope');
  }
  if (row.type === 'recorder.tools.available') {
    return exactKeys(row, [...common, 'source', 'projectID', 'sessionID', 'toolNames', 'modelToolNames', 'omissions'])
      && row.source === 'opencode.tool.list' && identifier(row.projectID) && identifier(row.sessionID)
      && [row.toolNames, row.modelToolNames].every(names => Array.isArray(names)
        && names.every(name => name !== null && toolName(name))) && strings(row.omissions);
  }
  if (!/^(?:session\.[a-z.-]+|permission\.(?:asked|replied)|form\.(?:created|replied|cancelled))$/.test(row.type)) return false;
  return exactKeys(row, [...common, 'source', 'eventID', 'sourceTime', 'sourceSequence', 'sourceVersion',
    'sourceAggregateID', 'projectID', 'sessionID', 'executionID', 'messageID', 'ordinal',
    'content', 'status', 'omissions', 'redactions', ...(Object.hasOwn(row, 'sessionObservedAt') ? relations : []),
    ...(Object.hasOwn(row, 'tool') ? ['tool'] : []), ...(Object.hasOwn(row, 'interaction') ? ['interaction'] : []),
    ...(Object.hasOwn(row, 'retry') ? ['retry'] : []), ...(Object.hasOwn(row, 'skill') ? ['skill'] : [])])
    && (!Object.hasOwn(row, 'sessionObservedAt') || (Number.isFinite(row.sessionObservedAt)
      && relations.filter(key => key !== 'sessionObservedAt').every(key => (key === 'toolName' ? toolName : identifier)(row[key]))))
    && row.source === 'opencode.event' && Number.isFinite(row.sourceTime)
    && ['eventID', 'sourceAggregateID', 'projectID', 'sessionID', 'messageID'].every(key => identifier(row[key]))
    && row.executionID === null && nullableInteger(row.sourceSequence, 0)
    && nullableInteger(row.sourceVersion, 1) && nullableInteger(row.ordinal, 0)
    && strings(row.omissions) && strings(row.redactions)
    && (!Object.hasOwn(row, 'tool') || validTool(row.tool))
    && (!Object.hasOwn(row, 'interaction') || validInteraction(row.interaction))
    && (!Object.hasOwn(row, 'retry') || validRetry(row.retry))
    && (!Object.hasOwn(row, 'skill') || validSkill(row.skill))
    && (row.status === 'captured'
      ? (row.content === null ? row.tool != null || row.interaction != null || row.retry != null || row.skill != null : exactKeys(row.content, ['role', 'text'])
        && ['user', 'assistant'].includes(row.content.role) && typeof row.content.text === 'string')
      : ['omitted', 'unrecognized'].includes(row.status) && row.content === null);
}

const [directory, sessionID, mode] = process.argv.slice(2);
if (!directory) {
  console.error('Usage: node scripts/inspect.mjs <capture-directory> [sessionID [--tree|--tools]]');
  process.exitCode = 1;
} else {
  try {
    if (mode && !['--tree', '--tools'].includes(mode)) throw new Error('Unknown inspection mode');
    // ponytail: tree/attempt inspection buffers the capture; add an index if it outgrows memory.
    const rows = [];
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.endsWith('.pending')) throw new Error(`Incomplete preparation: ${entry.name}`);
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      let lineNumber = 0;
      const lines = createInterface({ input: createReadStream(join(directory, entry.name)), crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          lineNumber++;
          const row = JSON.parse(line);
          if (!validRecord(row)) throw new Error('Unsupported or malformed capture');
          if (mode) rows.push(row);
          else if (!sessionID || row.sessionID === sessionID || (row.type.startsWith('recorder.') && !row.sessionID)) {
            console.log(JSON.stringify(row));
          }
        }
      } catch {
        throw new Error(`Invalid or incomplete capture: ${entry.name}, line ${lineNumber}`);
      }
    }
    const selected = new Set([sessionID]);
    if (mode === '--tree') {
      let size;
      do {
        size = selected.size;
        for (const row of rows) {
          if (row.sessionID && row.parentSessionID && selected.has(row.parentSessionID)) selected.add(row.sessionID);
          if (row.childSessionID && selected.has(row.sessionID)) selected.add(row.childSessionID);
        }
      } while (selected.size !== size);
    }
    for (const row of rows) {
      if (mode === '--tools') continue;
      if (!sessionID || selected.has(row.sessionID) || (row.type.startsWith('recorder.') && !row.sessionID)) console.log(JSON.stringify(row));
    }
    if (mode === '--tools') {
      const attempts = new Map();
      const horizons = [...new Map(rows.map(row => [row.captureID,
        { captureID: row.captureID, arrival: row.arrival, observedAt: row.observedAt }])).values()];
      for (const row of rows) {
        if (!row.type.startsWith('session.tool.') || (sessionID && row.sessionID !== sessionID)) continue;
        const complete = row.projectID && row.sessionID && row.messageID && row.callID;
        const key = JSON.stringify(complete ? [row.projectID, row.sessionID, row.messageID, row.callID]
          : [row.captureID, row.arrival]);
        let attempt = attempts.get(key);
        if (!attempt) {
          attempt = { diagnosticVersion: 1, type: 'diagnostic.tool-attempt', projectID: row.projectID,
            sessionID: row.sessionID, executionID: null, messageID: row.messageID, callID: row.callID,
            toolName: row.toolName, input: null, inputText: null, output: null, error: null,
            outcome: 'not-observed', startedAt: null, calledAt: null, endedAt: null,
            retryOf: null, operationID: null, consumption: null, incident: null, evidence: [],
            omissions: complete ? [] : ['incomplete-call-identity'], horizons };
          attempts.set(key, attempt);
        }
        attempt.evidence.push({ captureID: row.captureID, arrival: row.arrival, eventID: row.eventID, type: row.type });
        attempt.omissions.push(...row.omissions);
        if (row.toolName !== null) attempt.toolName = row.toolName;
        if (row.type === 'session.tool.input.started') attempt.startedAt = row.sourceTime;
        if (row.type === 'session.tool.called') attempt.calledAt = row.sourceTime;
        if (!row.tool) continue; // Omitted or unknown payloads are not terminal evidence of success.
        if (row.tool.input !== null) attempt.input = row.tool.input;
        if (row.tool.inputText !== null) attempt.inputText = row.tool.inputText;
        if (['session.tool.success', 'session.tool.failed'].includes(row.type)) {
          attempt.outcome = row.tool.outcome;
          attempt.output = row.tool.output;
          attempt.error = row.tool.error;
          attempt.endedAt = row.sourceTime;
        }
      }
      for (const attempt of attempts.values()) {
        if (attempt.outcome !== 'success') attempt.incident = {
          kind: attempt.outcome === 'error' ? 'tool-error' : 'outcome-not-observed', cause: null };
        if (attempt.startedAt === null) attempt.omissions.push('call-start-not-observed');
        attempt.omissions = [...new Set(attempt.omissions)];
        console.log(JSON.stringify(attempt));
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Cannot inspect capture');
    process.exitCode = 1;
  }
}
