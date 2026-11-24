import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const reader = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'inspect.mjs');
const ENTRY = 'session.inbox.enqueued';
const RESPONSE = 'session.text.ended';
const EXECUTION_PREFIX = 'session.execution.';
const cache = new Map();
const TTL = 700;

export function latestLifecycle(rows) {
  const events = rows.filter(row => row.type?.startsWith(EXECUTION_PREFIX));
  if (!events.length || events.some(row => row.sourceSequence === null
    || row.sourceAggregateID !== events[0].sourceAggregateID)) return null;
  return events.reduce((latest, row) => row.sourceSequence > latest.sourceSequence ? row : latest).lifecycle?.phase;
}

const runReader = (captureDirectory, sessionID) => new Promise(resolve => {
  const child = spawn(process.execPath, [reader, captureDirectory, ...(sessionID ? [sessionID] : [])]);
  let output = '';
  let errors = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { errors += chunk; });
  child.on('error', error => resolve({ ok: false, reason: error.message }));
  child.on('close', code => {
    if (code !== 0) return resolve({ ok: false, reason: errors.trim() || `reader exited with ${code}` });
    try {
      resolve({ ok: true, rows: output.split('\n').filter(Boolean).map(line => JSON.parse(line)) });
    } catch (error) {
      resolve({ ok: false, reason: error.message });
    }
  });
});

export async function readRows(captureDirectory, sessionID = null) {
  const key = `${captureDirectory}\u0000${sessionID ?? ''}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < TTL) return cached.value;
  if (cache.size > 50) cache.clear();
  const value = await runReader(captureDirectory, sessionID);
  cache.set(key, { at: Date.now(), value });
  return value;
}

export async function readSession(captureDirectory, sessionID) {
  const read = await readRows(captureDirectory);
  if (!read.ok) return { ok: false, reason: read.reason };
  const rows = read.rows.filter(row => row.sessionID === sessionID);
  return {
    ok: true,
    rows: read.rows,
    admission: rows.find(row => row.type === ENTRY && row.messageID),
    entries: rows.filter(row => row.type === ENTRY && row.content?.role === 'user')
      .map(row => ({ text: row.content.text })),
    responses: rows.filter(row => row.type === RESPONSE && row.content?.role === 'assistant')
      .map(row => ({ text: row.content.text })),
    captureIDs: [...new Set(rows.map(row => row.captureID).filter(Boolean))],
    recorderFailed: read.rows.some(row => row.type === 'recorder.failed'),
  };
}
