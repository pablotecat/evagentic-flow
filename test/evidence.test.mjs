import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSession } from '../webapp/evidence.mjs';

const temporary = process.env.OPENCODE_TEST_TMP ?? (process.platform === 'win32'
  ? join(process.env.LOCALAPPDATA, 'Temp/opencode') : tmpdir());

const event = (captureID, arrival, sessionID, observedAt, extra = {}) => ({
  schemaVersion: 1, captureID, arrival, observedAt, type: 'session.text.ended',
  source: 'opencode.event', eventID: `evt_${arrival}`, sourceTime: observedAt,
  sourceSequence: arrival, sourceVersion: 1, sourceAggregateID: sessionID,
  projectID: 'synthetic_project', sessionID, executionID: null, messageID: `msg_${arrival}`,
  ordinal: null, content: { role: 'assistant', text: 'Respuesta sintética autorizada.' },
  status: 'captured', omissions: [], redactions: [],
  parentSessionID: null, agentID: null, sessionObservedAt: observedAt,
  callID: null, toolName: null, childSessionID: null, ...extra,
});

test('el horizonte abarca sólo el árbol acreditado y conserva lagunas y omisiones con su procedencia', async () => {
  const directory = await mkdtemp(join(temporary, 'webapp-evidence-'));
  const captureID = randomUUID();
  const childCaptureID = randomUUID();
  const rows = [
    event(childCaptureID, 1, 'ses_grandchild', 3000, { parentSessionID: 'ses_child',
      omissions: ['non-text-fields-not-captured'] }),
    event(captureID, 1, 'ses_root', 1000, { childSessionID: 'ses_child',
      omissions: ['event-payload-not-captured'] }),
    event(captureID, 2, 'ses_child', 2000),
    event(captureID, 3, 'ses_unrelated', 9000, { omissions: ['unrelated-omission'] }),
    { schemaVersion: 1, captureID, arrival: 4, observedAt: 10000,
      type: 'recorder.gap', reason: 'unrecognized-session-envelope' },
  ];
  const file = join(directory, 'synthetic.jsonl');
  const bytes = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
  await writeFile(file, bytes);
  const evidence = await readSession(directory, 'ses_root');
  assert.equal(evidence.ok, true, evidence.reason);
  assert.deepEqual(evidence.scope, { kind: 'observed-session-tree', rootSessionID: 'ses_root',
    sessionIDs: ['ses_root', 'ses_child', 'ses_grandchild'] });
  assert.equal(evidence.horizon, new Date(3000).toISOString());
  assert.deepEqual(new Set(evidence.captureIDs), new Set([captureID, childCaptureID]));
  assert.equal(evidence.responses.length, 1, 'tree evidence must not merge descendant messages into the root conversation');
  assert.deepEqual(evidence.gaps, [{ captureID, arrival: 4, observedAt: 10000,
    scope: 'capture', reason: 'unrecognized-session-envelope' }]);
  assert.deepEqual(evidence.omissions.map(row => [row.sessionID, row.captureID, row.arrival, row.omissions]), [
    ['ses_grandchild', childCaptureID, 1, ['non-text-fields-not-captured']],
    ['ses_root', captureID, 1, ['event-payload-not-captured']],
  ]);
  const missing = await readSession(directory, 'ses_missing');
  assert.equal(missing.horizon, null);
  assert.deepEqual(missing.captureIDs, []);
  assert.deepEqual(missing.omissions, []);
  assert.deepEqual(missing.gaps, evidence.gaps, 'global gaps must not be silently attributed to a session');
  assert.equal(await readFile(file, 'utf8'), bytes);
});

test('un horizonte observado en época cero no se convierte en ausencia de evidencia', async () => {
  const directory = await mkdtemp(join(temporary, 'webapp-evidence-'));
  await writeFile(join(directory, 'synthetic.jsonl'), JSON.stringify(event(randomUUID(), 1, 'ses_root', 0)) + '\n');
  assert.equal((await readSession(directory, 'ses_root')).horizon, new Date(0).toISOString());
});

test('una captura ilegible no publica un horizonte ni lagunas inventadas', async () => {
  const directory = await mkdtemp(join(temporary, 'webapp-evidence-'));
  await writeFile(join(directory, 'synthetic.jsonl'), '{incomplete\n');
  const evidence = await readSession(directory, 'ses_root');
  assert.equal(evidence.ok, false);
  assert.match(evidence.reason, /Invalid or incomplete capture/);
  assert.equal(evidence.horizon, undefined);
  assert.equal(evidence.gaps, undefined);
});
