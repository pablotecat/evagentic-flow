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
    'content', 'status', 'omissions', 'redactions'])
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

const [directory, sessionID] = process.argv.slice(2);
if (!directory) {
  console.error('Usage: node scripts/inspect.mjs <capture-directory> [sessionID]');
  process.exitCode = 1;
} else {
  try {
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
          if (!sessionID || row.sessionID === sessionID || row.type.startsWith('recorder.')) {
            console.log(JSON.stringify(row));
          }
        }
      } catch {
        throw new Error(`Invalid or incomplete capture: ${entry.name}, line ${lineNumber}`);
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Cannot inspect capture');
    process.exitCode = 1;
  }
}
