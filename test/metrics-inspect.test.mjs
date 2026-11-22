import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const common = { schemaVersion: 1, captureID: '00000000-0000-4000-8000-000000000007', observedAt: 1 };
const tokens = { input: 11, output: 7, reasoning: 0, cache: { read: 0, write: 0 } };
const measurement = { kind: 'model-step', phase: 'ended', model: null, startedAt: null,
  tokens, costUSD: 0.000025, finish: 'stop', error: null };
const event = (type, extra = {}) => ({ ...common, type, source: 'opencode.event', eventID: null, sourceTime: 100,
  sourceSequence: 1, sourceVersion: 1, sourceAggregateID: 'session_root', projectID: 'project_synthetic',
  sessionID: 'session_root', executionID: null, messageID: 'msg_synthetic', ordinal: null, content: null,
  status: 'captured', omissions: [], redactions: [], measurement: null, lifecycle: null, ...extra });
async function capture(rows) {
  const directory = await mkdtemp(join(process.env.OPENCODE_TEST_TMP ??
    (process.platform === 'win32' ? join(process.env.LOCALAPPDATA, 'Temp/opencode') : '/tmp'), 'recorder-metric-contract-'));
  await writeFile(join(directory, 'synthetic.jsonl'), rows.map((row, index) =>
    JSON.stringify({ ...row, arrival: index + 1 })).join('\n') + '\n');
  return directory;
}
const inspect = (directory, ...args) => execFileSync(process.execPath,
  [fileURLToPath(new URL('../scripts/inspect.mjs', import.meta.url)), directory, ...args],
  { encoding: 'utf8', stdio: 'pipe' });

test('el lector rechaza métricas y desenlaces malformados o incompatibles con su evento y versión', async () => {
  const valid = event('session.step.ended', { measurement });
  const bad = [
    { measurement: { ...measurement, tokens: { ...tokens, input: -1 } } },
    { measurement: { ...measurement, tokens: { input: 11, output: 7 } } },
    { measurement: { ...measurement, tokens: { ...tokens, extra: 'synthetic-unsafe-payload' } } },
    { measurement: { ...measurement, costUSD: 'synthetic-unsafe-payload' } },
    { measurement: { ...measurement, model: { providerID: 'synthetic' } } },
    { measurement: { ...measurement, finish: '[REDACTED]' } },
    { measurement: { ...measurement, kind: '[REDACTED]' } },
    { measurement: { ...measurement, phase: 'failed' } },
    { measurement: { ...measurement, error: { type: 'Error', message: 'synthetic-unsafe-payload' } } },
    { sourceVersion: 2 }, { type: 'session.tool.success' }, { status: 'unrecognized' },
    { lifecycle: { phase: 'succeeded', reason: null, error: null, pendingWork: null } },
  ];
  for (const extra of bad) {
    const directory = await capture([{ ...valid, ...extra }]);
    for (const args of [[], ['session_root', '--metrics'], ['session_root', '--tools'], ['session_root', '--tree']]) {
      assert.throws(() => inspect(directory, ...args), error => error.status === 1 && error.stdout === ''
        && error.stderr.includes('line 1') && !error.stderr.includes('synthetic-unsafe-payload'));
    }
  }
});

test('los intervalos usan secuencia local, no suman concurrencia y no cruzan huecos de captura', async () => {
  const lifecycle = phase => ({ phase, reason: null, error: null, pendingWork: null });
  const directory = await capture([
    event('session.execution.started', { messageID: null, lifecycle: lifecycle('started') }),
    event('session.execution.succeeded', { messageID: null, lifecycle: lifecycle('succeeded'), sourceTime: 160, sourceSequence: 4 }),
    event('session.execution.started', { messageID: null, lifecycle: lifecycle('started'), sourceTime: 170, sourceSequence: 5 }),
    { ...common, type: 'recorder.gap', reason: 'unrecognized-session-envelope' },
    event('session.execution.succeeded', { messageID: null, lifecycle: lifecycle('succeeded'), sourceTime: 200, sourceSequence: 8 }),
    event('session.step.ended', { status: 'omitted', measurement: null }),
  ]);
  const report = inspect(directory, 'session_root', '--metrics').trim().split('\n').map(JSON.parse);
  const intervals = report.filter(row => row.type === 'diagnostic.execution-interval');
  assert.deepEqual(intervals.map(row => row.elapsedMs), [60, null, null]);
  assert.equal(intervals[1].outcome, 'not-observed');
  assert.equal(intervals[2].startedAt, null);
  assert.ok(intervals.every(row => row.executionID === null && row.pendingWork === null));
  const unknown = report.find(row => row.type === 'diagnostic.model-step');
  assert.equal(unknown.outcome, 'not-observed');
  assert.equal(unknown.tokens.value, null);
  assert.equal(unknown.costUSD.value, null);
  assert.equal(report.find(row => row.type === 'diagnostic.metric-coverage').flowElapsedMs, null);
});

test('los despachos repetidos conservan el intervalo completo sin inventar duración o consumo por intento', async () => {
  const start = startedAt => ({ ...measurement, phase: 'started', startedAt, model: { providerID: 'synthetic', id: 'synthetic' },
    tokens: null, costUSD: null, finish: null });
  const directory = await capture([
    event('session.step.started', { measurement: start(100), sourceTime: 110 }),
    event('session.step.started', { measurement: start(140), sourceTime: 140, sourceSequence: 2 }),
    event('session.step.streamed', { measurement: { ...measurement, phase: 'streamed', tokens: null,
      costUSD: null, finish: null }, sourceTime: 150, sourceSequence: 3 }),
    event('session.step.ended', { measurement, sourceTime: 160, sourceSequence: 4 }),
  ]);
  const step = inspect(directory, 'session_root', '--metrics').trim().split('\n').map(JSON.parse)
    .find(row => row.type === 'diagnostic.model-step');
  assert.equal(step.elapsedMs, 60);
  assert.equal(step.providerBodyMs, null);
  assert.deepEqual(step.dispatches.map(row => row.startedAt), [100, 140]);
  assert.ok(step.dispatches.every(row => row.tokens === null && row.costUSD === null));
  assert.equal(step.tokens.value.input, 11);
});
