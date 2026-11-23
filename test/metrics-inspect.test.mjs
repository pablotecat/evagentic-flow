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
async function capture(...journals) {
  const directory = await mkdtemp(join(process.env.OPENCODE_TEST_TMP ??
    (process.platform === 'win32' ? join(process.env.LOCALAPPDATA, 'Temp/opencode') : '/tmp'), 'recorder-metric-contract-'));
  for (const [index, rows] of journals.entries()) {
    const captureID = `00000000-0000-4000-8000-${(index + 7).toString(16).padStart(12, '0')}`;
    await writeFile(join(directory, `${captureID}.jsonl`), rows.map((row, index) =>
      JSON.stringify({ ...row, captureID, arrival: index + 1 })).join('\n') + '\n');
  }
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

test('un primer despacho sin medición impide sustituir su inicio por un despacho posterior reconocido', async () => {
  const start = { ...measurement, phase: 'started', startedAt: 140,
    model: { providerID: 'synthetic', id: 'synthetic' }, tokens: null, costUSD: null, finish: null };
  for (const status of ['omitted', 'unrecognized']) {
    for (const reversed of [false, true]) {
      const journals = [
        [event('session.step.started', { status, measurement: status === 'omitted' ? undefined : null,
          omissions: [status === 'omitted' ? 'event-payload-not-captured' : 'unrecognized-measurement-format'] })],
        [event('session.step.started', { measurement: start, sourceTime: 140, sourceSequence: 2 }),
          event('session.step.ended', { measurement, sourceTime: 160, sourceSequence: 3 })],
      ];
      const directory = await capture(...(reversed ? journals.reverse() : journals));
      const step = inspect(directory, 'session_root', '--metrics').trim().split('\n').map(JSON.parse)
        .find(row => row.type === 'diagnostic.model-step');
      assert.equal(step.startedAt, null);
      assert.equal(step.elapsedMs, null);
      assert.equal(step.providerBodyMs, null);
      assert.equal(step.dispatches.length, 2);
      const unknown = step.dispatches.find(row => row.startedAt === null);
      assert.equal(unknown.model.value, null);
      assert.equal(unknown.model.status, 'unknown');
      assert.equal(unknown.model.source, null);
      assert.equal(unknown.tokens, null);
      assert.equal(unknown.costUSD, null);
      assert.equal(unknown.evidence.type, 'session.step.started');
      assert.equal(step.dispatches.find(row => row.startedAt === 140).model.value.providerID, 'synthetic');
      assert.equal(step.model.value.providerID, 'synthetic');
      assert.equal(step.tokens.value.input, 11);
      assert.equal(step.costUSD.value, 0.000025);
      assert.equal(step.outcome, 'ended');
      assert.equal(step.evidence.length, 3);
      assert.equal(step.horizons.length, 2);
      assert.ok(step.omissions.includes('dispatch-measurement-not-observed'));
      assert.ok(step.omissions.includes('multiple-dispatches-body-duration-not-attributable'));
    }
  }
});

test('un despacho posterior sin medición impide atribuir el cuerpo a un único intento sin perder el intervalo válido', async () => {
  const start = { ...measurement, phase: 'started', startedAt: 100,
    model: { providerID: 'synthetic', id: 'synthetic' }, tokens: null, costUSD: null, finish: null };
  const stream = { ...measurement, phase: 'streamed', tokens: null, costUSD: null, finish: null };
  for (const status of ['omitted', 'unrecognized']) {
    for (const reversed of [false, true]) {
      for (const terminal of [false, true]) {
        const journals = [
          [event('session.step.started', { measurement: start, sourceTime: 110 })],
          [event('session.step.started', { status, sourceTime: 140, sourceSequence: 2,
            measurement: status === 'omitted' ? undefined : null }),
          event('session.step.streamed', { measurement: stream, sourceTime: 150, sourceSequence: 3 }),
          ...terminal ? [event('session.step.ended', { measurement, sourceTime: 160, sourceSequence: 4 })] : []],
        ];
        const directory = await capture(...(reversed ? journals.reverse() : journals));
        const step = inspect(directory, 'session_root', '--metrics').trim().split('\n').map(JSON.parse)
          .find(row => row.type === 'diagnostic.model-step');
        assert.equal(step.startedAt, 100);
        assert.equal(step.streamedAt, 150);
        assert.equal(step.elapsedMs, terminal ? 60 : null);
        assert.equal(step.providerBodyMs, null);
        assert.equal(step.dispatches.length, 2);
        assert.equal(step.dispatches.find(row => row.startedAt === null).model.status, 'unknown');
        assert.equal(step.model.value.providerID, 'synthetic');
        assert.equal(step.tokens.value?.input ?? null, terminal ? 11 : null);
        assert.equal(step.outcome, terminal ? 'ended' : 'not-observed');
        assert.equal(step.evidence.length, terminal ? 4 : 3);
        assert.ok(step.omissions.includes('dispatch-measurement-not-observed'));
        assert.ok(step.omissions.includes('multiple-dispatches-body-duration-not-attributable'));
      }
    }
  }
});

test('los despachos sin medición no se atribuyen a otra identidad ni completan identidades excluidas', async () => {
  const start = { ...measurement, phase: 'started', startedAt: 100,
    model: { providerID: 'synthetic', id: 'synthetic' }, tokens: null, costUSD: null, finish: null };
  const stream = { ...measurement, phase: 'streamed', tokens: null, costUSD: null, finish: null };
  for (const extra of [{ projectID: 'project_other' }, { sessionID: 'session_other' }, { messageID: 'msg_other' },
    { projectID: null }, { sessionID: null }, { messageID: null }]) {
    const directory = await capture([
      event('session.step.started', { status: 'unrecognized', sourceVersion: 2, ...extra }),
      event('session.step.started', { measurement: start, sourceTime: 110, sourceSequence: 2 }),
      event('session.step.streamed', { measurement: stream, sourceTime: 150, sourceSequence: 3 }),
      event('session.step.ended', { measurement, sourceTime: 160, sourceSequence: 4 }),
    ]);
    const steps = inspect(directory, '', '--metrics').trim().split('\n').map(JSON.parse)
      .filter(row => row.type === 'diagnostic.model-step');
    assert.equal(steps.length, 2);
    const known = steps.find(row => row.tokens.value !== null);
    assert.equal(known.startedAt, 100);
    assert.equal(known.elapsedMs, 60);
    assert.equal(known.providerBodyMs, 50);
    assert.equal(known.dispatches.length, 1);
    const unknown = steps.find(row => row.tokens.value === null);
    assert.equal(unknown.startedAt, null);
    assert.equal(unknown.elapsedMs, null);
    assert.equal(unknown.providerBodyMs, null);
    assert.equal(unknown.outcome, 'not-observed');
    assert.equal(unknown.dispatches.length, 1);
    assert.equal(unknown.dispatches[0].startedAt, null);
    assert.equal(unknown.model.status, 'unknown');
    assert.ok(unknown.omissions.includes('dispatch-measurement-not-observed'));
  }
});

test('el primer despacho usa evidencia del mismo agregado aunque los diarios se lean al revés', async () => {
  const start = startedAt => ({ ...measurement, phase: 'started', startedAt,
    model: { providerID: 'synthetic', id: 'synthetic' }, tokens: null, costUSD: null, finish: null });
  const directory = await capture([
    event('session.step.started', { measurement: start(140), sourceTime: 140, sourceSequence: 3 }),
    event('session.step.ended', { measurement, sourceTime: 160, sourceSequence: 4 }),
  ], [
    event('session.step.started', { measurement: start(100), sourceTime: 110 }),
    event('session.retry.scheduled', { status: 'captured', sourceTime: 120, sourceSequence: 2,
      retry: { kind: 'model', attempt: 2, at: 140, error: { type: 'Error', message: 'Synthetic retry' } } }),
  ]);
  const step = inspect(directory, 'session_root', '--metrics').trim().split('\n').map(JSON.parse)
    .find(row => row.type === 'diagnostic.model-step');
  assert.equal(step.startedAt, 100);
  assert.equal(step.elapsedMs, 60);
  assert.equal(step.providerBodyMs, null);
  assert.equal(step.retries[0].scheduledDelayMs, 20);
  assert.equal(step.retries[0].tokens, null);
  assert.equal(step.tokens.value.input, 11);
  assert.equal(step.dispatches.length, 2);
  assert.equal(step.evidence.length, 4);
  assert.deepEqual(step.horizons.map(row => row.arrival), [2, 2]);
});

test('un reloj aparentemente ordenado no basta para precisar duración sin evidencia pública comparable', async () => {
  const start = { ...measurement, phase: 'started', startedAt: 100,
    model: { providerID: 'synthetic', id: 'synthetic' }, tokens: null, costUSD: null, finish: null };
  const stream = { ...measurement, phase: 'streamed', tokens: null, costUSD: null, finish: null };
  for (const extra of [{ sourceAggregateID: null }, { sourceAggregateID: 'synthetic_other_aggregate' },
    { sourceSequence: null }, { sourceSequence: 1 }]) {
    const directory = await capture([
      event('session.step.streamed', { measurement: stream, sourceTime: 150, sourceSequence: 3, ...extra }),
      event('session.step.ended', { measurement, sourceTime: 160, sourceSequence: 4, ...extra }),
    ], [event('session.step.started', { measurement: start, sourceTime: 110 })]);
    const step = inspect(directory, 'session_root', '--metrics').trim().split('\n').map(JSON.parse)
      .find(row => row.type === 'diagnostic.model-step');
    assert.equal(step.startedAt, 100);
    assert.equal(step.elapsedMs, null);
    assert.equal(step.providerBodyMs, null);
    assert.equal(step.outcome, 'ended');
    assert.equal(step.tokens.value.input, 11);
    assert.ok(step.omissions.includes('step-duration-order-not-established'));
    assert.ok(step.omissions.includes('provider-body-order-not-established'));
  }
});

test('despachos incomparables o con tiempos contradictorios conservan evidencia sin inventar el inicio', async () => {
  const start = startedAt => ({ ...measurement, phase: 'started', startedAt,
    model: { providerID: 'synthetic', id: 'synthetic' }, tokens: null, costUSD: null, finish: null });
  for (const extra of [{ sourceAggregateID: null }, { sourceAggregateID: 'synthetic_other_aggregate' },
    { sourceSequence: null }, { sourceSequence: 1 }, { measurement: start(90) }]) {
    const directory = await capture([
      event('session.step.started', { measurement: start(140), sourceTime: 140, sourceSequence: 2, ...extra }),
      event('session.step.ended', { measurement, sourceTime: 160, sourceSequence: 4 }),
    ], [event('session.step.started', { measurement: start(100), sourceTime: 110 })]);
    const step = inspect(directory, 'session_root', '--metrics').trim().split('\n').map(JSON.parse)
      .find(row => row.type === 'diagnostic.model-step');
    assert.equal(step.startedAt, null);
    assert.equal(step.elapsedMs, null);
    assert.equal(step.providerBodyMs, null);
    assert.ok(step.omissions.includes('dispatch-order-not-established'));
    assert.equal(step.dispatches.length, 2);
    assert.equal(step.model.value.providerID, 'synthetic');
    assert.equal(step.tokens.value.input, 11);
  }
});

test('límites fuente invertidos o múltiples no fabrican una duración precisa', async () => {
  for (const [starts, streams, end, duration, omission] of [
    [[100, 180], [150], 160, null, 'step-duration-order-not-established'],
    [[100], [150, 155], 160, 60, 'multiple-step-streams-not-collapsed'],
    [[100], [90], 95, null, 'provider-body-order-not-established'],
  ]) {
    const rows = [
      ...starts.map(startedAt => event('session.step.started', { measurement: { ...measurement, phase: 'started',
        startedAt, model: { providerID: 'synthetic', id: 'synthetic' }, tokens: null, costUSD: null, finish: null } })),
      ...streams.map(sourceTime => event('session.step.streamed', { sourceTime,
        measurement: { ...measurement, phase: 'streamed', tokens: null, costUSD: null, finish: null } })),
      event('session.step.ended', { measurement, sourceTime: end }),
    ].map((row, index) => ({ ...row, sourceSequence: index + 1 }));
    const directory = await capture(rows);
    const step = inspect(directory, 'session_root', '--metrics').trim().split('\n').map(JSON.parse)
      .find(row => row.type === 'diagnostic.model-step');
    assert.equal(step.startedAt, 100);
    assert.equal(step.elapsedMs, duration);
    assert.equal(step.providerBodyMs, null);
    assert.ok(step.omissions.includes(omission));
    assert.equal(step.tokens.value.input, 11);
  }
});

test('entrega y cancelación resuelven solo su identidad por secuencia aunque sus diarios se lean antes', async () => {
  const admission = messageID => event('session.inbox.enqueued', { messageID,
    content: { role: 'user', text: 'Synthetic pending work' } });
  const terminal = (type, messageID, extra = {}) => event(type, { messageID, status: 'omitted',
    sourceTime: 90, sourceSequence: 5, ...extra });
  const directory = await capture([
    terminal('session.inbox.delivered', 'msg_delivered'),
    terminal('session.inbox.cancelled', 'msg_cancelled', { sourceSequence: 6 }),
    terminal('session.inbox.delivered', 'msg_pending', { projectID: 'project_other' }),
  ], [admission('msg_delivered'), admission('msg_cancelled'), admission('msg_pending')]);
  const report = inspect(directory, 'session_root', '--metrics').trim().split('\n').map(JSON.parse);
  const pending = report.filter(row => row.type === 'diagnostic.pending-inbox');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].messageID, 'msg_pending');
  assert.equal(pending[0].state, 'delivery-not-observed');
  assert.deepEqual(pending[0].horizons.map(row => row.arrival), [3, 3]);
});

test('una resolución de inbox sin orden acreditado queda desconocida, no se oculta ni se declara ausente', async () => {
  for (const extra of [{ sourceAggregateID: null }, { sourceAggregateID: 'synthetic_other_aggregate' },
    { sourceSequence: null }, { sourceSequence: 1 }, { sourceSequence: 0 }]) {
    const directory = await capture([
      event('session.inbox.delivered', { status: 'omitted', sourceTime: 160, sourceSequence: 5, ...extra }),
    ], [event('session.inbox.enqueued', { content: { role: 'user', text: 'Synthetic pending work' } })]);
    const pending = inspect(directory, 'session_root', '--metrics').trim().split('\n').map(JSON.parse)
      .find(row => row.type === 'diagnostic.pending-inbox');
    assert.equal(pending.state, 'unknown');
    assert.ok(pending.omissions.includes('inbox-resolution-order-not-established'));
    assert.deepEqual(pending.evidence.map(row => row.type), ['session.inbox.enqueued', 'session.inbox.delivered']);
    assert.equal(pending.horizons.length, 2);
  }
});
