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
// A missing/excluded session identity does not make session evidence global.
const globalRecord = row => ['recorder.ready', 'recorder.failed', 'recorder.gap'].includes(row.type);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nullableString = value => value === null || typeof value === 'string';
const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const validError = value => value === null || (exactKeys(value, ['type', 'message',
  ...Object.hasOwn(value, 'status') ? ['status'] : []]) && typeof value.type === 'string' && typeof value.message === 'string'
  && (!Object.hasOwn(value, 'status') || (Number.isInteger(value.status) && value.status >= 100 && value.status <= 599)));
const validTokens = value => value === null || (exactKeys(value, ['input', 'output', 'reasoning', 'cache'])
  && [value.input, value.output, value.reasoning].every(nonnegative)
  && exactKeys(value.cache, ['read', 'write']) && [value.cache.read, value.cache.write].every(nonnegative));
const validMeasurement = row => {
  const value = row.measurement;
  if (value === null) return true;
  if (!exactKeys(value, ['kind', 'phase', 'model', 'startedAt', 'tokens', 'costUSD', 'finish', 'error'])
    || !validTokens(value.tokens) || !(value.costUSD === null || nonnegative(value.costUSD)) || !validError(value.error)
    || ![null, 'stop', 'length', 'tool-calls', 'content-filter', 'error', 'unknown'].includes(value.finish)
    || !(value.model === null || (exactKeys(value.model, ['providerID', 'id'])
      && typeof value.model.providerID === 'string' && typeof value.model.id === 'string'))
    || !(value.startedAt === null || nonnegative(value.startedAt))) return false;
  const total = value.kind === 'session-total';
  const prefix = value.kind === 'model-step' ? 'session.step.' : value.kind === 'compaction' ? 'session.compaction.' : null;
  if (total ? row.type !== 'session.usage.updated' || value.phase !== 'updated' || row.sourceVersion !== null
    : !prefix || row.type !== prefix + value.phase || row.sourceVersion !== 1) return false;
  if (total && (value.model !== null || value.finish !== null)) return false;
  if (value.kind === 'compaction' && (!['ended', 'failed'].includes(value.phase) || value.finish !== null)) return false;
  if (value.kind === 'model-step' && !['started', 'streamed', 'ended', 'failed'].includes(value.phase)) return false;
  if (value.phase === 'started') return value.model !== null && value.startedAt !== null && value.tokens === null
    && value.costUSD === null && value.finish === null && value.error === null;
  if (value.startedAt !== null) return false;
  if (value.phase === 'streamed') return value.model === null && value.tokens === null && value.costUSD === null
    && value.finish === null && value.error === null;
  if (value.kind === 'model-step' && value.model !== null) return false;
  if (value.phase === 'failed') return value.error !== null && (value.finish === null || value.finish === 'content-filter');
  return value.error === null && (value.kind === 'compaction' || (value.tokens !== null && value.costUSD !== null))
    && (value.kind !== 'model-step' || value.finish !== null);
};
const validLifecycle = row => row.lifecycle === null || (exactKeys(row.lifecycle, ['phase', 'reason', 'error', 'pendingWork'])
  && ['started', 'succeeded', 'failed', 'interrupted'].includes(row.lifecycle.phase)
  && row.type === `session.execution.${row.lifecycle.phase}` && row.sourceVersion === 1
  && row.lifecycle.pendingWork === null && validError(row.lifecycle.error)
  && (row.lifecycle.phase === 'interrupted' ? ['user', 'shutdown', 'superseded', 'inactivity'].includes(row.lifecycle.reason)
    : row.lifecycle.reason === null)
  && (row.lifecycle.phase === 'failed' ? row.lifecycle.error !== null : row.lifecycle.error === null));
const validContext = (source, value) => exactKeys(value, ['kind', 'agentID', 'model', 'system', 'messages', 'tools', 'finalContext'])
  && value.kind === (source === 'opencode.session.hook.context' ? 'primary' : source.split('.').at(-1))
  && nullableString(value.agentID) && exactKeys(value.model, ['providerID', 'id'])
  && typeof value.model.providerID === 'string' && typeof value.model.id === 'string'
  && Array.isArray(value.system) && value.system.every(part => exactKeys(part, ['text', 'instructions'])
    && typeof part.text === 'string' && (part.instructions === null || (Array.isArray(part.instructions)
      && part.instructions.every(entry => exactKeys(entry, ['key', 'text'])
        && typeof entry.key === 'string' && typeof entry.text === 'string'))))
  && Array.isArray(value.messages) && value.messages.every(message => exactKeys(message, ['id', 'role', 'text'])
    && identifier(message.id) && ['system', 'user', 'assistant', 'tool'].includes(message.role) && strings(message.text))
  && (source === 'opencode.session.hook.title' ? value.agentID === null && value.tools === null
    : object(value.tools) && Object.values(value.tools).every(tool => tool === '[REDACTED]'
      || (exactKeys(tool, ['description', 'input']) && typeof tool.description === 'string'
        && (typeof tool.input === 'boolean' || object(tool.input)))))
  && value.finalContext === false;
const skillSummary = value => typeof value.id === 'string' && typeof value.name === 'string'
  && nullableString(value.description) && (value.autoinvoke === null || typeof value.autoinvoke === 'boolean');
function validProjection({ stage, source, value }) {
  switch (stage) {
    case 'availability':
      return Array.isArray(value) && value.every(skill => exactKeys(skill, ['id', 'name', 'description', 'autoinvoke'])
        && skillSummary(skill));
    case 'admitted-skill':
      return value === null || (exactKeys(value, ['id', 'name', 'text'])
        && [value.id, value.name, value.text].every(text => typeof text === 'string'));
    case 'runtime-definition':
      return source === 'opencode.skill.list'
        ? value === null || (exactKeys(value, ['id', 'name', 'description', 'content', 'path', 'autoinvoke'])
          && skillSummary(value) && typeof value.content === 'string' && typeof value.path === 'string')
        : exactKeys(value, ['id', 'name', 'mode', 'description', 'system'])
          && typeof value.id === 'string' && typeof value.name === 'string' && ['primary', 'subagent', 'all'].includes(value.mode)
          && nullableString(value.description) && nullableString(value.system);
    case 'deployed-file':
      return exactKeys(value, ['path', 'content']) && nullableString(value.path) && nullableString(value.content);
    case 'context-hook':
      return validContext(source, value);
    case 'environment':
      return exactKeys(value, ['plugins', 'configurationSources', 'transformations'])
        && value.configurationSources === null && value.transformations === null && Array.isArray(value.plugins)
        && value.plugins.every(plugin => exactKeys(plugin, ['id', 'source', 'version', 'status'])
          && nullableString(plugin.id) && ['builtin', 'local', 'package', 'sdk'].includes(plugin.source)
          && nullableString(plugin.version) && ['active', 'failed'].includes(plugin.status));
    default: return false;
  }
}

// These are observation intervals, not invented causal execution IDs or billable totals.
const elapsed = (start, end) => start !== null && end !== null && end >= start ? end - start : null;
const sourceBefore = (a, b) => a.projectID && a.projectID === b.projectID && a.sessionID && a.sessionID === b.sessionID
  && a.sourceAggregateID && a.sourceAggregateID === b.sourceAggregateID
  && a.sourceSequence !== null && b.sourceSequence !== null && a.sourceSequence < b.sourceSequence;
function printMetrics(rows, allRows) {
  const ref = row => ({ captureID: row.captureID, arrival: row.arrival, eventID: row.eventID ?? null, type: row.type });
  const base = (row, type) => ({ diagnosticVersion: 1, type, projectID: row.projectID, sessionID: row.sessionID,
    executionID: null, messageID: row.messageID ?? null, callID: row.callID ?? null });
  const metric = (value, source, scope, status = 'observed') => ({ value, status: value === null ? 'unknown' : status,
    source: value === null ? null : source, scope });
  const usage = row => ({
    tokens: { ...metric(row.measurement.tokens, `opencode.event.${row.type}.tokens`, row.measurement.kind),
      basis: 'runtime-normalized-unverified', providerReported: null },
    costUSD: { ...metric(row.measurement.costUSD, `opencode.event.${row.type}.cost`, row.measurement.kind, 'estimated'),
      basis: 'runtime-estimate-not-invoice' },
  });
  const horizons = [...new Map(allRows.map(row => [row.captureID,
    { captureID: row.captureID, arrival: row.arrival, observedAt: row.observedAt }])).values()];
  const emit = row => console.log(JSON.stringify({ ...row, horizons }));
  emit({ diagnosticVersion: 1, type: 'diagnostic.metric-coverage', flowElapsedMs: null,
    omissions: ['flow-boundaries-not-exposed', 'execution-causal-id-not-exposed', 'no-concurrent-duration-sum',
      'no-session-total-plus-step-sum', 'provider-usage-provenance-not-exposed', 'billed-cost-not-exposed',
      'auxiliary-usage-attribution-not-exposed', 'skill-consumption-not-exposed'],
    recorderDiagnostics: rows.filter(globalRecord).map(row => ({ ...ref(row), reason: row.reason ?? null })) });
  const steps = new Map();
  const executions = new Map();
  const waits = new Map();
  const segments = new Map();
  for (const row of rows) {
    if (['recorder.gap', 'recorder.failed'].includes(row.type)) {
      segments.set(row.captureID, (segments.get(row.captureID) ?? 0) + 1);
    }
    if (row.type.startsWith('session.execution.') && !row.lifecycle) {
      segments.set(row.captureID, (segments.get(row.captureID) ?? 0) + 1);
      emit({ ...base(row, 'diagnostic.execution-interval'), intervalRef: ref(row), startedAt: null, endedAt: null,
        elapsedMs: null, durationSource: 'opencode.event.sourceTime', outcome: 'not-observed', state: 'unknown',
        reason: null, error: null, pendingWork: null, evidence: [ref(row)],
        omissions: [...row.omissions, 'lifecycle-payload-not-observed'] });
    }
    const complete = row.projectID && row.sessionID && row.messageID;
    const key = JSON.stringify(complete ? [row.projectID, row.sessionID, row.messageID] : [row.captureID, row.arrival]);
    if (/^session\.step\.(started|streamed|ended|failed)$/.test(row.type) || row.retry) {
      let step = steps.get(key);
      if (!step) {
        step = { ...base(row, 'diagnostic.model-step'),
          model: metric(null, null, 'model-step'), tokens: { ...metric(null, null, 'model-step'), providerReported: null },
          costUSD: metric(null, null, 'model-step'), startedAt: null, streamedAt: null, endedAt: null,
          elapsedMs: null, providerBodyMs: null, outcome: 'not-observed', finish: null, error: null,
          durationSource: 'opencode.event.session.step.started.started-to-terminal.sourceTime',
          skillConsumption: null, dispatches: [], retries: [], results: [], evidence: [],
          startRows: [], streamRows: [], endRows: [],
          omissions: complete ? [] : ['incomplete-step-identity'] };
        steps.set(key, step);
      }
      step.evidence.push(ref(row)); step.omissions.push(...row.omissions);
      if (row.retry) step.retries.push({ ...row.retry, tokens: null, costUSD: null,
        scheduledDelayMs: elapsed(row.sourceTime, row.retry.at), actualWaitMs: null, evidence: ref(row) });
      const value = row.measurement;
      if (row.type === 'session.step.started') {
        const model = metric(value?.model ?? null, `opencode.event.${row.type}.model`, 'model-step');
        if (value) {
          if (!step.startRows.some(row => row.measurement)) step.model = model;
          else if (JSON.stringify(step.model.value) !== JSON.stringify(model.value)) {
            step.model = metric(null, null, 'model-step'); step.omissions.push('multiple-dispatch-models');
          }
        } else step.omissions.push('dispatch-measurement-not-observed');
        step.dispatches.push({ startedAt: value?.startedAt ?? null, model, tokens: null, costUSD: null, evidence: ref(row) });
        step.startRows.push(row);
      }
      if (value) {
        if (value.phase === 'streamed') step.streamRows.push(row);
        if (['ended', 'failed'].includes(value.phase)) {
          step.endRows.push(row);
          step.results.push({ phase: value.phase, finish: value.finish, error: value.error, ...usage(row), evidence: ref(row) });
          if (step.results.length === 1) {
            Object.assign(step, usage(row), { endedAt: row.sourceTime, outcome: value.phase,
              finish: value.finish, error: value.error });
          } else {
            step.outcome = 'ambiguous'; step.tokens = { ...metric(null, null, 'model-step'), providerReported: null };
            step.costUSD = metric(null, null, 'model-step'); step.endedAt = null;
            step.finish = null; step.error = null; step.omissions.push('multiple-step-results-not-collapsed');
          }
        }
      }
    } else if (row.measurement) {
      emit({ ...base(row, 'diagnostic.measurement'), kind: row.measurement.kind,
        model: metric(row.measurement.model, `opencode.event.${row.type}.model`, row.measurement.kind),
        ...usage(row), outcome: row.measurement.phase, error: row.measurement.error,
        evidence: [ref(row)], omissions: row.omissions });
    }
    if (row.lifecycle) {
      const complete = row.projectID && row.sessionID && row.sourceAggregateID && row.sourceSequence !== null;
      const group = JSON.stringify(complete ? [row.captureID, segments.get(row.captureID) ?? 0,
        row.projectID, row.sessionID, row.sourceAggregateID]
        : [row.captureID, row.arrival]);
      if (!executions.has(group)) executions.set(group, []);
      executions.get(group).push(row);
    }
    if (row.interaction) {
      const interaction = row.interaction;
      const complete = row.projectID && row.sessionID && interaction.requestID;
      const group = JSON.stringify(complete
        ? [row.captureID, row.projectID, row.sessionID, interaction.kind, interaction.requestID] : [row.captureID, row.arrival]);
      let wait = waits.get(group);
      if (!wait || interaction.phase === 'requested') {
        if (wait) emit({ ...wait, elapsedMs: elapsed(wait.startedAt, wait.endedAt) });
        wait = { ...base(row, 'diagnostic.wait'), kind: interaction.kind, requestID: interaction.requestID,
          startedAt: null, endedAt: null, outcome: 'not-observed', evidence: [],
          durationSource: 'opencode.event.sourceTime',
          omissions: ['external-actor-not-exposed', 'wait-is-not-proof-that-all-work-stopped'] };
        waits.set(group, wait);
      }
      wait.evidence.push(ref(row));
      if (interaction.phase === 'requested') wait.startedAt = row.sourceTime;
      else { wait.endedAt = row.sourceTime; wait.outcome = interaction.phase; }
    }
  }
  for (const { startRows, streamRows, endRows, ...step } of steps.values()) {
    // Compare only this public step identity, never filenames or local observation times.
    let first = startRows.reduce((first, row) => sourceBefore(row, first) ? row : first, startRows[0]);
    if (first && !startRows.every(row => row === first || (sourceBefore(first, row)
      && (!first.measurement || !row.measurement
        || first.measurement.startedAt <= row.measurement.startedAt)))) first = undefined;
    step.startedAt = first?.measurement?.startedAt ?? null;
    if (startRows.length && !first) step.omissions.push('dispatch-order-not-established');
    const end = endRows.length === 1 ? endRows[0] : null;
    const stream = streamRows.length === 1 ? streamRows[0] : null;
    step.streamedAt = stream?.sourceTime ?? null;
    step.elapsedMs = first && end && startRows.every(row => sourceBefore(row, end)
      && (!row.measurement || row.measurement.startedAt <= end.sourceTime)) ? elapsed(step.startedAt, step.endedAt) : null;
    step.providerBodyMs = startRows.length === 1 && stream && sourceBefore(first, stream)
      ? elapsed(step.startedAt, step.streamedAt) : null;
    if (first && end && step.startedAt !== null && step.elapsedMs === null) step.omissions.push('step-duration-order-not-established');
    if (startRows.length === 1 && stream && step.providerBodyMs === null) step.omissions.push('provider-body-order-not-established');
    if (streamRows.length > 1) step.omissions.push('multiple-step-streams-not-collapsed');
    if (step.dispatches.length > 1) step.omissions.push('multiple-dispatches-body-duration-not-attributable');
    step.state = step.finish === 'content-filter' ? 'blocked' : step.outcome;
    step.omissions = [...new Set(step.omissions)]; emit(step);
  }
  for (const events of executions.values()) {
    events.sort((a, b) => a.sourceSequence - b.sourceSequence);
    let start;
    const interval = end => {
      const row = end ?? start;
      emit({ ...base(row, 'diagnostic.execution-interval'), intervalRef: ref(start ?? row),
        startedAt: start?.sourceTime ?? null, endedAt: end?.sourceTime ?? null,
        elapsedMs: elapsed(start?.sourceTime ?? null, end?.sourceTime ?? null),
        durationSource: 'opencode.event.sourceTime', outcome: end?.lifecycle.phase ?? 'not-observed',
        state: end?.lifecycle.phase === 'succeeded' ? 'concluded' : end?.lifecycle.phase ?? 'unknown',
        reason: end?.lifecycle.reason ?? null, error: end?.lifecycle.error ?? null, pendingWork: null,
        evidence: [start, end].filter(Boolean).map(ref),
        omissions: ['observed-interval-is-not-causal-execution-id', 'pending-work-description-not-exposed',
          ...!start ? ['execution-start-not-observed'] : [], ...!end ? ['execution-end-not-observed'] : []] });
    };
    for (const row of events) {
      if (row.lifecycle.phase === 'started') { if (start) interval(); start = row; }
      else { interval(row); start = undefined; }
    }
    if (start) interval();
  }
  for (const wait of waits.values()) emit({ ...wait, elapsedMs: elapsed(wait.startedAt, wait.endedAt),
    state: wait.startedAt !== null && wait.endedAt === null ? 'waiting-external-decision' : 'not-waiting-or-unknown' });
  // Pending inbox work is session-scoped. Delivery is not a success/acceptance signal.
  const inbox = new Map();
  for (const row of rows) {
    if (row.sourceVersion !== 1 || !row.projectID || !row.sessionID || !row.messageID) continue;
    if (!['session.inbox.enqueued', 'session.inbox.delivered', 'session.inbox.cancelled'].includes(row.type)) continue;
    const key = JSON.stringify([row.projectID, row.sessionID, row.messageID]);
    if (!inbox.has(key)) inbox.set(key, { admissions: [], resolutions: [] });
    const item = inbox.get(key);
    (row.type === 'session.inbox.enqueued' ? item.admissions : item.resolutions).push(row);
  }
  for (const { admissions, resolutions } of inbox.values()) {
    if (admissions.every(row => resolutions.some(end => sourceBefore(row, end)))) continue;
    emit({ ...base(admissions[0], 'diagnostic.pending-inbox'),
      state: resolutions.length ? 'unknown' : 'delivery-not-observed',
      evidence: [...admissions, ...resolutions].map(ref),
      omissions: ['execution-and-completion-not-implied', 'pending-at-read-horizon-not-causal-terminal-snapshot',
        ...resolutions.length ? ['inbox-resolution-order-not-established'] : []] });
  }
}

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
        && validProjection(row)
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
    ...(Object.hasOwn(row, 'retry') ? ['retry'] : []), ...(Object.hasOwn(row, 'skill') ? ['skill'] : []),
    ...(Object.hasOwn(row, 'measurement') ? ['measurement'] : []), ...(Object.hasOwn(row, 'lifecycle') ? ['lifecycle'] : [])])
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
    && (!Object.hasOwn(row, 'measurement') || validMeasurement(row))
    && (!Object.hasOwn(row, 'lifecycle') || validLifecycle(row))
    && (row.status === 'captured' || (row.measurement == null && row.lifecycle == null))
    && (row.status === 'captured'
      ? (row.content === null ? row.tool != null || row.interaction != null || row.retry != null || row.skill != null
        || row.measurement != null || row.lifecycle != null : exactKeys(row.content, ['role', 'text'])
        && ['user', 'assistant'].includes(row.content.role) && typeof row.content.text === 'string')
      : ['omitted', 'unrecognized'].includes(row.status) && row.content === null);
}

const [directory, sessionID, mode] = process.argv.slice(2);
if (!directory) {
  console.error('Usage: node scripts/inspect.mjs <capture-directory> [sessionID [--tree|--tools|--metrics]]');
  process.exitCode = 1;
} else {
  try {
    if (mode && !['--tree', '--tools', '--metrics'].includes(mode)) throw new Error('Unknown inspection mode');
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
          else if (!sessionID || row.sessionID === sessionID || globalRecord(row)) {
            console.log(JSON.stringify(row));
          }
        }
      } catch {
        throw new Error(`Invalid or incomplete capture: ${entry.name}, line ${lineNumber}`);
      }
    }
    const selected = new Set([sessionID]);
    if (mode === '--tree' || mode === '--metrics') {
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
      if (mode === '--tools' || mode === '--metrics') continue;
      if (!sessionID || selected.has(row.sessionID) || globalRecord(row)) console.log(JSON.stringify(row));
    }
    if (mode === '--metrics') printMetrics(rows.filter(row => !sessionID || selected.has(row.sessionID) || globalRecord(row)), rows);
    if (mode === '--tools' || mode === '--metrics') {
      const attempts = new Map();
      const horizons = [...new Map(rows.map(row => [row.captureID,
        { captureID: row.captureID, arrival: row.arrival, observedAt: row.observedAt }])).values()];
      for (const row of rows) {
        if (!row.type.startsWith('session.tool.') || (sessionID && (mode === '--metrics'
          ? !selected.has(row.sessionID) : row.sessionID !== sessionID))) continue;
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
        if (mode === '--metrics') {
          attempt.elapsedMs = elapsed(attempt.calledAt, attempt.endedAt);
          attempt.durationSource = 'opencode.event.sourceTime.called-to-terminal';
        }
        console.log(JSON.stringify(attempt));
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Cannot inspect capture');
    process.exitCode = 1;
  }
}
