import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eventually, fixture, records } from './support/instance.mjs';

const inspect = (instance, sessionID) => execFileSync(process.execPath,
  [fileURLToPath(new URL('../scripts/inspect.mjs', import.meta.url)), instance.captureDirectory, sessionID, '--metrics'],
  { encoding: 'utf8', stdio: 'pipe' }).trim().split('\n').filter(Boolean).map(JSON.parse);

test('las métricas concurrentes conservan mensaje, fuente y alcance sin repartir consumo ni sumar duraciones',
  { timeout: 90000 }, async t => {
    const instance = await fixture(t, { simulation: true, modelCost: { input: 1, output: 2 } });
    const root = (await instance.api('/api/session', { location: { directory: instance.projects[0] } })).data;
    const child = (await instance.api('/api/session', { location: { directory: instance.projects[0] }, parentID: root.id })).data;
    const outside = (await instance.api('/api/session', { location: { directory: instance.projects[1] } })).data;
    await Promise.all([
      instance.api(`/api/session/${root.id}/prompt`, { text: 'SYNTHETIC_USAGE_A' }),
      instance.api(`/api/session/${child.id}/prompt`, { text: 'SYNTHETIC_USAGE_B' }),
      instance.api(`/api/session/${outside.id}/prompt`, { text: 'SYNTHETIC_USAGE_B' }),
    ]);
    await Promise.all([root, child, outside].map(session => instance.api(`/api/experimental/session/${session.id}/wait`, {})));
    const evidence = await eventually(async () => {
      const all = await records(instance.captureDirectory);
      return all.filter(row => row.type === 'session.execution.succeeded').length === 2 && all;
    }, 'concurrent runs did not finish');
    const report = inspect(instance, root.id);
    assert.ok(!JSON.stringify(report).includes(outside.id));
    const steps = report.filter(row => row.type === 'diagnostic.model-step');
    assert.equal(steps.length, 2);
    for (const [session, input, output, cost] of [[root, 11, 7, 0.000025], [child, 31, 13, 0.000057]]) {
      const step = steps.find(row => row.sessionID === session.id);
      assert.equal(step.executionID, null);
      assert.equal(step.callID, null);
      assert.equal(step.model.value.providerID, 'synthetic');
      assert.equal(step.model.value.id, 'synthetic');
      assert.equal(step.model.status, 'observed');
      assert.equal(step.tokens.value.input, input);
      assert.equal(step.tokens.value.output, output);
      assert.equal(step.tokens.status, 'observed');
      assert.equal(step.tokens.scope, 'model-step');
      assert.equal(step.tokens.source, 'opencode.event.session.step.ended.tokens');
      assert.equal(step.tokens.providerReported, null);
      assert.equal(step.costUSD.status, 'estimated');
      assert.ok(Math.abs(step.costUSD.value - cost) < 1e-12);
      assert.equal(step.costUSD.source, 'opencode.event.session.step.ended.cost');
      assert.equal(step.outcome, 'ended');
      assert.ok(step.elapsedMs >= 0);
      assert.ok(step.providerBodyMs >= 0);
      assert.equal(step.skillConsumption, null);
      assert.ok(evidence.some(row => row.messageID === step.messageID && row.measurement?.tokens?.input === input));
    }
    const intervals = report.filter(row => row.type === 'diagnostic.execution-interval');
    assert.equal(intervals.length, 2);
    assert.ok(intervals.every(row => row.outcome === 'succeeded' && row.elapsedMs >= 0));
    assert.ok(Math.max(...intervals.map(row => row.startedAt)) < Math.min(...intervals.map(row => row.endedAt)));
    assert.equal(report.find(row => row.type === 'diagnostic.metric-coverage').flowElapsedMs, null);
    assert.ok(instance.simulationLog().includes('"path":"/v1/chat/completions"'));
  });

test('los reintentos y fallos recuperados retienen evidencia y consumo desconocido por intento',
  { timeout: 90000 }, async t => {
    const instance = await fixture(t, { simulation: true, syntheticTools: true,
      config: { secrets: ['synthetic-secret-42'] } });
    const session = (await instance.api('/api/session', { location: { directory: instance.projects[0] } })).data;
    await instance.api(`/api/session/${session.id}/prompt`, { text: 'SYNTHETIC_PROVIDER_RETRY SYNTHETIC_USAGE_A' });
    await instance.api(`/api/experimental/session/${session.id}/wait`, {});
    await instance.api(`/api/session/${session.id}/prompt`, { text: 'SYNTHETIC_ACTION_RECOVERY' });
    await instance.api(`/api/experimental/session/${session.id}/wait`, {});
    await eventually(async () => (await records(instance.captureDirectory))
      .filter(row => row.type === 'session.execution.succeeded').length === 2, 'recovered runs were not persisted');
    const report = inspect(instance, session.id);
    const recovered = report.find(row => row.type === 'diagnostic.model-step' && row.retries.length);
    assert.equal(recovered.outcome, 'ended');
    assert.equal(recovered.tokens.value.input, 11);
    assert.equal(recovered.retries[0].attempt, 2);
    assert.equal(recovered.retries[0].error.status, 429);
    assert.equal(recovered.retries[0].tokens, null);
    assert.equal(recovered.retries[0].costUSD, null);
    assert.ok(recovered.retries[0].error.message.includes('[REDACTED]'));
    assert.ok(recovered.dispatches.length > 1);
    assert.equal(recovered.startedAt, recovered.dispatches[0].startedAt);
    assert.equal(recovered.providerBodyMs, null);
    assert.ok(recovered.dispatches.every(row => row.tokens === null && row.costUSD === null));
    const tools = report.filter(row => row.type === 'diagnostic.tool-attempt');
    assert.deepEqual(tools.map(row => row.outcome), ['error', 'success']);
    assert.equal(tools[0].incident.kind, 'tool-error');
    assert.ok(tools.every(row => row.consumption === null && row.elapsedMs >= 0));
    assert.equal(report.filter(row => row.type === 'diagnostic.execution-interval').length, 2);
    assert.ok(!JSON.stringify(report).includes('synthetic-secret-42'));
    const traffic = instance.simulationLog().split('\n').filter(Boolean).map(JSON.parse);
    assert.equal(traffic.filter(row => row.event === 'request' && row.statusCode === 429).length, 3,
      'tool continuations must not reset the synthetic retry budget');
    assert.ok(traffic.some(row => row.event === 'request' && row.statusCode === 200));
  });

test('interrupción y fallo conservan motivos sin inventar métricas ni trabajo pendiente resuelto',
  { timeout: 90000 }, async t => {
    const instance = await fixture(t, { simulation: true });
    const interrupted = (await instance.api('/api/session', { location: { directory: instance.projects[0] } })).data;
    await instance.api(`/api/session/${interrupted.id}/prompt`, { text: 'SYNTHETIC_LONG_RUNNING' });
    await eventually(async () => (await records(instance.captureDirectory)).some(row => row.type === 'session.text.delta'),
      'interruptible model did not start');
    const before = inspect(instance, interrupted.id).find(row => row.type === 'diagnostic.model-step');
    assert.equal(before.outcome, 'not-observed');
    assert.equal(before.tokens.value, null);
    assert.equal(before.tokens.status, 'unknown');
    assert.equal(before.costUSD.value, null);
    assert.equal(before.endedAt, null);
    await instance.api(`/api/session/${interrupted.id}/interrupt`, { resume: false });
    await instance.api(`/api/experimental/session/${interrupted.id}/wait`, {});
    const failed = (await instance.api('/api/session', { location: { directory: instance.projects[0] } })).data;
    await instance.api(`/api/session/${failed.id}/prompt`, { text: 'SYNTHETIC_AGENT_FAILURE' });
    await instance.api(`/api/experimental/session/${failed.id}/wait`, {});
    await eventually(async () => (await records(instance.captureDirectory))
      .some(row => row.sessionID === failed.id && row.type === 'session.execution.failed'), 'failed run was not persisted');
    const terminal = inspect(instance, interrupted.id).find(row => row.type === 'diagnostic.execution-interval');
    assert.equal(terminal.outcome, 'interrupted');
    assert.equal(terminal.reason, 'user');
    assert.equal(terminal.pendingWork, null);
    assert.ok(terminal.elapsedMs >= 0);
    const report = inspect(instance, failed.id);
    const failure = report.find(row => row.type === 'diagnostic.model-step');
    assert.equal(failure.outcome, 'failed');
    assert.equal(failure.tokens.value, null);
    assert.equal(failure.tokens.status, 'unknown');
    assert.equal(failure.costUSD.value, null);
    assert.equal(failure.error.status, 400);
    assert.equal(report.find(row => row.type === 'diagnostic.execution-interval').outcome, 'failed');
  });

test('espera externa, inbox pendiente y bloqueo observado no equivalen a conclusión satisfactoria',
  { timeout: 90000 }, async t => {
    const instance = await fixture(t, { simulation: true });
    const session = (await instance.api('/api/session', { location: { directory: instance.projects[0] } })).data;
    await instance.api(`/api/session/${session.id}/prompt`, { text: 'Synthetic pending work', resume: false });
    const form = (await instance.api(`/api/session/${session.id}/form`, { title: 'Synthetic human decision',
      fields: [{ key: 'decision', type: 'string' }] })).data;
    await eventually(async () => (await records(instance.captureDirectory)).some(row => row.type === 'form.created'),
      'waiting form was not persisted');
    let report = inspect(instance, session.id);
    const wait = report.find(row => row.type === 'diagnostic.wait');
    assert.equal(wait.state, 'waiting-external-decision');
    assert.equal(wait.elapsedMs, null);
    assert.equal(wait.outcome, 'not-observed');
    assert.equal(report.find(row => row.type === 'diagnostic.pending-inbox').state, 'delivery-not-observed');
    assert.ok(!report.some(row => row.type === 'diagnostic.execution-interval'));
    await instance.api(`/api/session/${session.id}/form/${form.id}/reply`, { answer: { decision: 'Proceed' } });
    await instance.api(`/api/session/${session.id}/prompt`, { text: 'SYNTHETIC_BLOCKED' });
    await instance.api(`/api/experimental/session/${session.id}/wait`, {});
    await eventually(async () => (await records(instance.captureDirectory))
      .some(row => row.measurement?.finish === 'content-filter'), 'content filter was not observed');
    report = inspect(instance, session.id);
    assert.equal(report.find(row => row.type === 'diagnostic.wait').outcome, 'replied');
    assert.ok(report.find(row => row.type === 'diagnostic.wait').elapsedMs >= 0);
    assert.equal(report.find(row => row.type === 'diagnostic.model-step' && row.finish === 'content-filter').state, 'blocked');
  });

test('una recarga pública no vuelve pendiente un encargo entregado aunque se lean primero los diarios posteriores',
  { timeout: 90000 }, async t => {
    const instance = await fixture(t, { simulation: true });
    const session = (await instance.api('/api/session', { location: { directory: instance.projects[0] } })).data;
    const admitted = (await instance.api(`/api/session/${session.id}/prompt`,
      { text: 'Synthetic admitted before reload', resume: false })).data;
    await eventually(async () => (await records(instance.captureDirectory))
      .some(row => row.type === 'session.inbox.enqueued' && row.messageID === admitted.id), 'admission was not persisted');
    assert.equal(inspect(instance, session.id).find(row => row.type === 'diagnostic.pending-inbox').messageID, admitted.id);
    await instance.api('/api/location/reload', {});
    await instance.api(`/api/session/${session.id}/prompt`, { text: 'SYNTHETIC_USAGE_A' });
    await instance.api(`/api/experimental/session/${session.id}/wait`, {});
    const evidence = await eventually(async () => {
      const all = await records(instance.captureDirectory);
      return all.some(row => row.type === 'session.execution.succeeded') && all;
    }, 'post-reload run was not persisted');
    const admission = evidence.find(row => row.type === 'session.inbox.enqueued' && row.messageID === admitted.id);
    const delivery = evidence.find(row => row.type === 'session.inbox.delivered' && row.messageID === admitted.id);
    assert.ok(delivery);
    assert.notEqual(admission.captureID, delivery.captureID);
    assert.ok(admission.sourceAggregateID);
    assert.equal(admission.sourceAggregateID, delivery.sourceAggregateID);
    assert.ok(Number.isSafeInteger(admission.sourceSequence) && Number.isSafeInteger(delivery.sourceSequence));
    assert.ok(admission.sourceSequence < delivery.sourceSequence);
    await instance.api('/api/location/reload', {});
    const reversed = await mkdtemp(join(instance.root, 'reversed-journals-'));
    for (const [row, name] of [[delivery, '00000000-0000-4000-8000-000000000001'],
      [admission, 'ffffffff-ffff-4fff-8fff-ffffffffffff']]) {
      await copyFile(join(instance.captureDirectory, `${row.captureID}.jsonl`), join(reversed, `${name}.jsonl`));
    }
    const report = inspect({ captureDirectory: reversed }, session.id);
    assert.ok(!report.some(row => row.type === 'diagnostic.pending-inbox'));
    assert.ok(report.every(row => row.horizons.length === 2));
    assert.equal(report.find(row => row.type === 'diagnostic.model-step').tokens.value.input, 11);
    assert.equal(report.find(row => row.type === 'diagnostic.execution-interval').outcome, 'succeeded');
  });

test('el uso auxiliar y los snapshots no se atribuyen al último mensaje ni se suman como consumo nuevo',
  { timeout: 90000 }, async t => {
    const instance = await fixture(t, { simulation: true });
    const session = (await instance.api('/api/session', { location: { directory: instance.projects[0] } })).data;
    await instance.api(`/api/session/${session.id}/prompt`, { text: 'Synthetic response without provider usage' });
    await instance.api(`/api/experimental/session/${session.id}/wait`, {});
    const transient = (await instance.api(`/api/session/${session.id}/generate`, { prompt: 'Synthetic auxiliary request' })).data;
    assert.equal(typeof transient.text, 'string');
    await instance.api(`/api/session/${session.id}/compact`, {});
    await instance.api(`/api/experimental/session/${session.id}/wait`, {});
    await eventually(async () => (await records(instance.captureDirectory))
      .some(row => row.type === 'session.compaction.failed'), 'failed compaction usage was not persisted');
    const report = inspect(instance, session.id);
    const auxiliary = report.find(row => row.type === 'diagnostic.measurement' && row.kind === 'compaction');
    assert.equal(auxiliary.outcome, 'failed');
    assert.equal(auxiliary.error.type, 'compaction.failed');
    assert.equal(auxiliary.tokens.value.input, 0);
    assert.equal(auxiliary.tokens.providerReported, null);
    assert.equal(auxiliary.tokens.scope, 'compaction');
    assert.equal(auxiliary.messageID, null);
    assert.equal(auxiliary.executionID, null);
    const snapshots = report.filter(row => row.type === 'diagnostic.measurement' && row.kind === 'session-total');
    assert.ok(snapshots.length > 0);
    assert.ok(snapshots.every(row => row.messageID === null && row.executionID === null
      && row.omissions.includes('session-total-is-snapshot-not-additive')));
    const missing = report.find(row => row.type === 'diagnostic.model-step');
    assert.equal(missing.tokens.providerReported, null);
    assert.equal(missing.tokens.basis, 'runtime-normalized-unverified');
    assert.ok(report.find(row => row.type === 'diagnostic.metric-coverage').omissions.includes('auxiliary-usage-attribution-not-exposed'));
  });

test('el filtrado de un motivo estructural conserva el hueco sin acreditar un desenlace de modelo diferente',
  { timeout: 90000 }, async t => {
    const instance = await fixture(t, { simulation: true, config: { secrets: ['stop'] } });
    const session = (await instance.api('/api/session', { location: { directory: instance.projects[0] } })).data;
    await instance.api(`/api/session/${session.id}/prompt`, { text: 'SYNTHETIC_USAGE_A' });
    await instance.api(`/api/experimental/session/${session.id}/wait`, {});
    const evidence = await eventually(async () => {
      const all = await records(instance.captureDirectory);
      return all.some(row => row.type === 'session.execution.succeeded') && all;
    }, 'redacted run did not finish');
    const terminal = evidence.find(row => row.type === 'session.step.ended');
    assert.equal(terminal.measurement, null);
    assert.equal(terminal.status, 'unrecognized');
    assert.ok(terminal.redactions.includes('configured-literal'));
    const step = inspect(instance, session.id).find(row => row.type === 'diagnostic.model-step');
    assert.equal(step.outcome, 'not-observed');
    assert.equal(step.tokens.value, null);
    assert.ok(step.omissions.includes('unrecognized-measurement-format'));
  });
