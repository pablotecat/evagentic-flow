import { createReadStream } from 'node:fs';
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

function validRecord(row) {
  if (row?.schemaVersion !== 1 || typeof row.captureID !== 'string'
    || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(row.captureID)
    || !Number.isSafeInteger(row.arrival) || row.arrival < 1 || !Number.isFinite(row.observedAt)
    || typeof row.type !== 'string') return false;
  if (row.type === 'recorder.ready') {
    return exactKeys(row, [...common, 'runtimeVersion', 'sdkVersion', 'coverage'])
      && typeof row.runtimeVersion === 'string' && typeof row.sdkVersion === 'string'
      && exactKeys(row.coverage, ['replay', 'content', 'excluded', 'executionID', 'ordering'])
      && row.coverage.replay === false && strings(row.coverage.content) && strings(row.coverage.excluded)
      && row.coverage.executionID === 'not-exposed' && row.coverage.ordering === 'arrival-is-not-causality';
  }
  if (row.type === 'recorder.failed' || row.type === 'recorder.gap') {
    return exactKeys(row, [...common, 'reason']) && row.reason === (row.type === 'recorder.failed'
      ? 'event-stream-or-persistence-failure' : 'unrecognized-session-envelope');
  }
  if (!/^session\.[a-z.-]+$/.test(row.type)) return false;
  return exactKeys(row, [...common, 'source', 'eventID', 'sourceTime', 'sourceSequence', 'sourceVersion',
    'sourceAggregateID', 'projectID', 'sessionID', 'executionID', 'messageID', 'ordinal',
    'content', 'status', 'omissions', 'redactions', ...(Object.hasOwn(row, 'sessionObservedAt') ? relations : [])])
    && (!Object.hasOwn(row, 'sessionObservedAt') || (Number.isFinite(row.sessionObservedAt)
      && relations.filter(key => key !== 'sessionObservedAt').every(key => identifier(row[key]))))
    && row.source === 'opencode.event' && Number.isFinite(row.sourceTime)
    && ['eventID', 'sourceAggregateID', 'projectID', 'sessionID', 'messageID'].every(key => identifier(row[key]))
    && row.executionID === null && nullableInteger(row.sourceSequence, 0)
    && nullableInteger(row.sourceVersion, 1) && nullableInteger(row.ordinal, 0)
    && strings(row.omissions) && strings(row.redactions)
    && (row.status === 'captured'
      ? exactKeys(row.content, ['role', 'text']) && ['user', 'assistant'].includes(row.content.role)
        && typeof row.content.text === 'string'
      : ['omitted', 'unrecognized'].includes(row.status) && row.content === null);
}

const [directory, sessionID, mode] = process.argv.slice(2);
if (!directory) {
  console.error('Usage: node scripts/inspect.mjs <capture-directory> [sessionID [--tree]]');
  process.exitCode = 1;
} else {
  try {
    if (mode && mode !== '--tree') throw new Error('Unknown inspection mode');
    // ponytail: tree selection buffers the capture; add an index if it outgrows memory.
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
          if (mode === '--tree') rows.push(row);
          else if (!sessionID || row.sessionID === sessionID || row.type.startsWith('recorder.')) {
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
      if (!sessionID || selected.has(row.sessionID) || row.type.startsWith('recorder.')) console.log(JSON.stringify(row));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Cannot inspect capture');
    process.exitCode = 1;
  }
}
