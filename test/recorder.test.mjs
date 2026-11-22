import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { eventually, fixture, records } from './support/instance.mjs';

test('preparación comprueba OpenCode V2 y persiste un contrato inspeccionable', { timeout: 90000 }, async t => {
  const instance = await fixture(t);
  assert.equal((await instance.api('/api/info')).version, '2.1.2');
  const { data: session } = await instance.api('/api/session', {
    location: { directory: instance.projects[0] }, title: 'Synthetic preparation' });
  await instance.api(`/api/session/${session.id}/prompt`, { text: 'Synthetic preparation', resume: false });
  const recorder = await eventually(async () => (await instance.plugins()).find(plugin => plugin.id === 'evagentic.recorder'),
    'recorder plugin did not activate');
  assert.equal(recorder.state.status, 'active', JSON.stringify(recorder));
  const [ready] = await records(instance.captureDirectory);
  assert.equal(ready?.schemaVersion, 1);
  assert.equal(ready?.type, 'recorder.ready');
  assert.equal(ready?.runtimeVersion, '2.1.2');
  assert.equal(ready?.coverage.replay, false);
  await instance.api('/api/location/reload', {});
  await instance.api(`/api/session/${session.id}/prompt`, { text: 'Recarga sana.', resume: false });
  await eventually(async () => (await records(instance.captureDirectory))
    .filter(row => row.type === 'recorder.ready').length === 2, 'healthy cleanup incorrectly latched a failure');
});

test('el encargo y la respuesta persisten sin cliente y tras finalizar la instancia', { timeout: 90000 }, async t => {
  const instance = await fixture(t, { simulation: true, config: { secrets: ['synthetic-secret-42'] } });
  const { data: session } = await instance.api('/api/session', {
    location: { directory: instance.projects[0] }, title: 'Flujo en Proyecto' });
  const { data: prompt } = await instance.api(`/api/session/${session.id}/prompt`, {
    text: 'Encargo autorizado. clave synthetic-secret-42.',
    metadata: { authorization: 'synthetic-metadata-secret' } });
  // No event client, browser or export is connected while the model streams its reply.
  const evidence = await eventually(async () => {
    const all = await records(instance.captureDirectory);
    return all.some(row => row.type === 'session.text.ended') && all;
  }, 'completed response was not persisted');
  const input = evidence.find(row => row.type === 'session.inbox.enqueued');
  const output = evidence.find(row => row.type === 'session.text.ended');
  assert.equal(input.content.text, 'Encargo autorizado. clave [REDACTED].');
  assert.equal(output.content.text, 'Respuesta autorizada. clave [REDACTED].');
  assert.equal(input.messageID, prompt.id);
  assert.equal(output.projectID, session.projectID);
  assert.equal(output.sessionID, session.id);
  assert.match(output.messageID, /^msg_/);
  assert.equal(output.executionID, null);
  assert.ok(output.eventID && output.sourceTime && output.sourceSequence !== null);
  assert.equal(output.source, 'opencode.event');
  const deltas = evidence.filter(row => row.type === 'session.text.delta');
  assert.ok(deltas.length > 0);
  assert.ok(deltas.every(row => row.content === null && row.status === 'omitted'
    && row.sourceSequence === null && row.omissions.includes('event-payload-not-captured')));
  const serialized = JSON.stringify(evidence);
  for (const secret of ['synthetic-secret-42', 'synthetic-metadata-secret', 'synthetic-header-secret']) {
    assert.ok(!serialized.includes(secret));
  }
  const requests = instance.simulationLog().split('\n').filter(Boolean).map(line => JSON.parse(line))
    .filter(event => event.event === 'request');
  assert.ok(requests.some(event => event.routeKey === 'model' && event.method === 'POST'
    && event.path === '/v1/chat/completions' && event.statusCode === 200), 'no model HTTP request was served');
  await instance.stop();
  assert.deepEqual((await records(instance.captureDirectory)).slice(0, evidence.length), evidence);
  const inspected = execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/inspect.mjs', import.meta.url)),
    instance.captureDirectory, session.id], { encoding: 'utf8' });
  assert.ok(inspected.includes('Encargo autorizado.') && inspected.includes('Respuesta autorizada.'));
});

test('credenciales reconocibles se omiten sin perder el texto de trabajo', { timeout: 90000 }, async t => {
  const instance = await fixture(t);
  const { data: session } = await instance.api('/api/session', { location: { directory: instance.projects[0] } });
  await instance.api(`/api/session/${session.id}/prompt`, { resume: false,
    text: 'Trabajo permitido. {"password":"synthetic-quoted-secret"}\nBearer synthetic-bearer-secret\n'
      + '-----BEGIN PRIVATE KEY-----\nsynthetic-private-secret\n-----END PRIVATE KEY-----\n'
      + String.raw`{"password":"prefix\"synthetic-escaped-secret"}` + '\nFin permitido.' });
  const row = await eventually(async () => (await records(instance.captureDirectory))
    .find(row => row.type === 'session.inbox.enqueued'), 'admitted prompt was not persisted');
  const serialized = JSON.stringify(await records(instance.captureDirectory));
  for (const secret of ['synthetic-quoted-secret', 'synthetic-bearer-secret', 'synthetic-private-secret', 'synthetic-escaped-secret']) {
    assert.ok(!serialized.includes(secret), `recognized credential leaked: ${secret}`);
  }
  assert.ok(row.content.text.startsWith('Trabajo permitido.'));
  assert.ok(row.content.text.endsWith('Fin permitido.'));
  assert.deepEqual(row.redactions, ['credential-pattern']);
});

test('el lector rechaza evidencia v1 estructuralmente inválida sin imprimir su contenido', async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const directory = await mkdtemp(join(process.env.OPENCODE_TEST_TMP ??
    (process.platform === 'win32' ? join(process.env.LOCALAPPDATA, 'Temp/opencode') : '/tmp'), 'recorder-invalid-'));
  await writeFile(join(directory, 'invalid.jsonl'), '{"schemaVersion":1,"unsafe":"synthetic-unknown-secret"}\n');
  assert.throws(() => execFileSync(process.execPath,
    [fileURLToPath(new URL('../scripts/inspect.mjs', import.meta.url)), directory], { encoding: 'utf8', stdio: 'pipe' }),
  error => error.status === 1 && error.stdout === '' && error.stderr.includes('line 1')
    && !error.stderr.includes('synthetic-unknown-secret'));
});

test('seleccionar cualquiera de dos proyectos solo cambia configuración y excluye el otro', { timeout: 120000 }, async t => {
  for (const projectIndex of [0, 1]) {
    const instance = await fixture(t, { projectIndex, simulation: true,
      config: { secrets: ['synthetic-secret-42'] } });
    const selected = (await instance.api('/api/session', {
      location: { directory: instance.projects[projectIndex] } })).data;
    const excluded = (await instance.api('/api/session', {
      location: { directory: instance.projects[1 - projectIndex] } })).data;
    await instance.api(`/api/session/${selected.id}/prompt`, { text: 'Encargo seleccionado.' });
    await instance.api(`/api/experimental/session/${selected.id}/wait`, {});
    await instance.api(`/api/session/${excluded.id}/prompt`, { text: 'Contenido fuera de alcance.' });
    await instance.api(`/api/experimental/session/${excluded.id}/wait`, {});
    await instance.api(`/api/session/${selected.id}/prompt`, { text: 'Barrera de captura.', resume: false });
    await eventually(async () => (await records(instance.captureDirectory))
      .some(row => row.content?.text === 'Barrera de captura.'), 'selected-project barrier was not persisted');
    const all = await records(instance.captureDirectory);
    const events = all.filter(row => row.source === 'opencode.event');
    assert.ok(events.some(row => row.type === 'session.text.ended'));
    assert.ok(events.every(row => row.projectID === selected.projectID && row.sessionID === selected.id));
    assert.equal(new Set(events.map(row => row.eventID)).size, events.length, 'multiple plugin instances duplicated events');
    assert.ok(!JSON.stringify(all).includes(excluded.id));
    assert.ok(!JSON.stringify(all).includes(excluded.projectID));
    assert.ok(!JSON.stringify(all).includes('Contenido fuera de alcance.'));
    await instance.stop();
  }
});

test('un destino no escribible avisa y bloquea el encargo antes de comenzar', { timeout: 90000 }, async t => {
  const instance = await fixture(t, { simulation: true, config: async ({ root }) => {
    const blocked = join(root, 'blocked');
    await writeFile(blocked, 'Not a directory');
    return { captureDirectory: blocked };
  } });
  const { data: session } = await instance.api('/api/session', { location: { directory: instance.projects[0] } });
  await assert.rejects(instance.api(`/api/session/${session.id}/prompt`, { text: 'No comenzar sin captura.' }), /500:/);
  const plugin = await eventually(async () => (await instance.plugins()).find(row => row.id === 'evagentic.recorder'),
    'failed recorder was not reported');
  // The runtime hook must remain active even though recorder preparation failed.
  assert.equal(plugin.state.status, 'active');
  const { data } = await instance.api(`/api/session/${session.id}`);
  assert.match(data.title, /Fallo del registrador/);
  assert.equal(data.metadata.evagenticRecorder.status, 'failed');
  assert.equal(data.metadata.evagenticRecorder.reason, 'preparation-failure');
  assert.equal(data.metadata.evagenticRecorder.interruption.stop, 'unconfirmed');
  assert.equal(data.metadata.evagenticRecorder.pilotReady, false);
  assert.ok(!instance.simulationLog().includes('"event":"request"'), 'model ran despite failed preparation');
  assert.deepEqual(await records(instance.captureDirectory), []);
});

test('un fallo de escritura avisa, interrumpe sin navegador y conserva la evidencia', { timeout: 90000 }, async t => {
  const instance = await fixture(t, { simulation: true, projectIndex: 1 });
  const { data: session } = await instance.api('/api/session', { location: { directory: instance.projects[1] } });
  await instance.api(`/api/session/${session.id}/prompt`, { text: 'SYNTHETIC_LONG_RUNNING Flujo en Proyecto' });
  const evidence = await eventually(async () => {
    const all = await records(instance.captureDirectory);
    return all.some(row => row.type === 'session.text.delta') && all;
  }, 'controlled execution did not start');
  // Fail the real filesystem boundary, not a recorder collaborator. Keep the original evidence.
  const preserved = join(instance.root, 'preserved');
  await rename(instance.captureDirectory, preserved);
  await writeFile(instance.captureDirectory, 'Synthetic unavailable capture destination');
  await instance.api(`/api/session/${session.id}/prompt`, { text: 'Barrera de escritura.', resume: false });
  const notice = await eventually(async () => {
    const { data } = await instance.api(`/api/session/${session.id}`);
    return data.metadata?.evagenticRecorder?.interruption.stop === 'confirmed' && data.metadata.evagenticRecorder;
  }, 'public recorder failure notice was not published');
  assert.match(notice.notice, /Revisar antes de volver a ejecutar/);
  assert.equal(notice.interruption.requested, true);
  assert.equal(notice.interruption.result, 'accepted');
  assert.equal(notice.reviewRequired, true);
  assert.equal(notice.pilotReady, false);
  await instance.api(`/api/experimental/session/${session.id}/wait`, {});
  const stopped = (await instance.api(`/api/session/${session.id}`)).data;
  assert.equal(stopped.outcome, 'interrupted');
  await assert.rejects(instance.api(`/api/session/${session.id}/prompt`, { text: 'No reanudar sin revisión.' }),
    /500:/); // 2.1.2 rejects a throwing hook without a typed/public response body.
  assert.deepEqual((await records(preserved)).slice(0, evidence.length), evidence);
  // Repairing the destination and reloading is not a review or permission to resume.
  await unlink(instance.captureDirectory);
  await rename(preserved, instance.captureDirectory);
  const beforeReload = await records(instance.captureDirectory);
  await instance.api('/api/location/reload', {});
  await assert.rejects(instance.api(`/api/session/${session.id}/prompt`, { text: 'No ignorar el fallo tras recargar.' }), /500:/);
  assert.deepEqual(await records(instance.captureDirectory), beforeReload);
  const excluded = (await instance.api('/api/session', { location: { directory: instance.projects[0] } })).data;
  await instance.api(`/api/session/${excluded.id}/prompt`, { text: 'Proyecto fuera del alcance.' });
  await instance.api(`/api/experimental/session/${excluded.id}/wait`, {});
  assert.equal((await instance.api(`/api/session/${excluded.id}`)).data.outcome, 'succeeded');
  const inspected = execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/inspect.mjs', import.meta.url)),
    instance.captureDirectory, session.id], { encoding: 'utf8' });
  assert.ok(inspected.includes('SYNTHETIC_LONG_RUNNING Flujo en Proyecto'));
});

test('el fallo del agente registrado y los límites de cobertura no averían el registrador', { timeout: 90000 }, async t => {
  const instance = await fixture(t, { simulation: true });
  const { data: session } = await instance.api('/api/session', { location: { directory: instance.projects[0] } });
  await instance.api(`/api/session/${session.id}/prompt`, { text: 'SYNTHETIC_AGENT_FAILURE' });
  await instance.api(`/api/experimental/session/${session.id}/wait`, {});
  const evidence = await eventually(async () => {
    const all = await records(instance.captureDirectory);
    return all.some(row => row.type === 'session.execution.failed') && all;
  }, 'agent failure was not captured');
  assert.ok(evidence.some(row => row.status === 'omitted' && row.omissions.includes('event-payload-not-captured')));
  assert.ok(!evidence.some(row => row.type === 'recorder.failed'));
  assert.equal((await instance.api(`/api/session/${session.id}`)).data.metadata?.evagenticRecorder, undefined);
  await instance.api(`/api/session/${session.id}/prompt`, { text: 'Encargo admitido tras fallo del agente.', resume: false });
  await eventually(async () => (await records(instance.captureDirectory))
    .some(row => row.content?.text === 'Encargo admitido tras fallo del agente.'), 'recorder incorrectly blocked the flow');
  assert.ok(instance.simulationLog().includes('"statusCode":400'), 'agent failure did not cross real HTTP');
});

test('un error real de herramienta se registra sin solicitar la parada del flujo', { timeout: 90000 }, async t => {
  const instance = await fixture(t, { simulation: true });
  const { data: session } = await instance.api('/api/session', { location: { directory: instance.projects[0] } });
  await instance.api(`/api/session/${session.id}/prompt`, { text: 'SYNTHETIC_TOOL_FAILURE' });
  await instance.api(`/api/experimental/session/${session.id}/wait`, {});
  const messages = (await instance.api(`/api/session/${session.id}/message`)).data;
  const tool = messages.flatMap(message => message.content ?? []).find(part => part.type === 'tool');
  // Code Mode reports a completed tool with error:true, not session.tool.failed in this runtime.
  assert.equal(tool.state.metadata.error, true);
  assert.deepEqual(tool.state.content, [{ type: 'text', text: 'Error: Synthetic tool failure' }]);
  const evidence = await eventually(async () => {
    const all = await records(instance.captureDirectory);
    return all.some(row => row.type === 'session.tool.success') && all;
  }, 'real tool failure was not captured');
  const result = evidence.find(row => row.type === 'session.tool.success');
  assert.equal(result.tool.reportedError, true);
  assert.equal(result.tool.outcome, 'error');
  assert.deepEqual(result.tool.output, [{ type: 'text', text: 'Error: Synthetic tool failure' }]);
  assert.ok(!evidence.some(row => row.type === 'recorder.failed'));
  assert.equal((await instance.api(`/api/session/${session.id}`)).data.metadata?.evagenticRecorder, undefined);
  await instance.api(`/api/session/${session.id}/prompt`, { text: 'Barrera tras fallo de herramienta.', resume: false });
  await eventually(async () => (await records(instance.captureDirectory))
    .some(row => row.content?.text === 'Barrera tras fallo de herramienta.'), 'tool failure incorrectly blocked the recorder');
});

test('la configuración inválida avisa también a una sesión nueva sin admitir trabajo', { timeout: 90000 }, async t => {
  const instance = await fixture(t, { simulation: true, config: { version: 999 } });
  for (let index = 0; index < 2; index++) {
    const { data: session } = await instance.api('/api/session', { location: { directory: instance.projects[0] } });
    await assert.rejects(instance.api(`/api/session/${session.id}/prompt`, { text: 'No comenzar sin configuración válida.' }), /500:/);
    const { data } = await instance.api(`/api/session/${session.id}`);
    assert.match(data.title, /Fallo del registrador/);
    assert.equal(data.metadata.evagenticRecorder.reviewRequired, true);
    assert.equal(data.metadata.evagenticRecorder.pilotReady, false);
  }
  assert.deepEqual(await records(instance.captureDirectory), []);
  assert.ok(!instance.simulationLog().includes('"event":"request"'));
});

test('perder una sesión en la adquisición interrumpe la ejecución simple y conserva el diagnóstico', { timeout: 90000 }, async t => {
  const instance = await fixture(t, { simulation: true });
  const { data: session } = await instance.api('/api/session', { location: { directory: instance.projects[0] } });
  await instance.api(`/api/session/${session.id}/prompt`, { text: 'SYNTHETIC_LONG_RUNNING adquisición' });
  await eventually(async () => (await records(instance.captureDirectory))
    .some(row => row.type === 'session.text.delta'), 'controlled execution did not start');
  // The public deletion removes the object the event acquisition must resolve, without replacing that logic.
  const removed = (await instance.api('/api/session', { location: { directory: instance.projects[0] } })).data;
  await instance.api(`/api/session/${removed.id}`, undefined, 'DELETE');
  const state = await eventually(async () => {
    const { data } = await instance.api(`/api/session/${session.id}`);
    return data.metadata?.evagenticRecorder?.interruption.stop === 'confirmed' && data.metadata.evagenticRecorder;
  }, 'acquisition failure did not interrupt the observed execution');
  assert.equal(state.reason, 'event-stream-or-persistence-failure');
  const evidence = await eventually(async () => {
    const all = await records(instance.captureDirectory);
    return all.some(row => row.type === 'recorder.failed') && all;
  }, 'acquisition failure diagnosis was not preserved');
  assert.ok(evidence.some(row => row.content?.text === 'SYNTHETIC_LONG_RUNNING adquisición'));
  assert.equal((await instance.api(`/api/session/${session.id}`)).data.outcome, 'interrupted');
});

test('perder la ruta del proyecto no impide interrumpir el trabajo ya observado', { timeout: 90000 }, async t => {
  const instance = await fixture(t, { simulation: true, projectAlias: true });
  const { data: session } = await instance.api('/api/session', { location: { directory: instance.projects[0] } });
  await instance.api(`/api/session/${session.id}/prompt`, { text: 'SYNTHETIC_LONG_RUNNING ruta perdida' });
  await eventually(async () => (await records(instance.captureDirectory))
    .some(row => row.type === 'session.text.delta'), 'controlled execution did not start');
  await unlink(instance.projects[0]); // Remove only the synthetic alias, not the watched project or its data.
  await instance.api(`/api/session/${session.id}`, { title: 'Evento tras perder la ruta.' }, 'PATCH');
  await eventually(async () => {
    const { data } = await instance.api(`/api/session/${session.id}`);
    return data.metadata?.evagenticRecorder?.interruption.stop === 'confirmed';
  }, 'previously observed execution was not interrupted after losing its path');
});

test('una admisión en curso no despacha modelos después de fallar la captura', { timeout: 90000 }, async t => {
  const instance = await fixture(t, { simulation: true, admissionGate: true });
  const session = (await instance.api('/api/session', { location: { directory: instance.projects[0] } })).data;
  await instance.api(`/api/session/${session.id}/prompt`, { text: 'SYNTHETIC_LONG_RUNNING admisión' });
  await eventually(async () => (await records(instance.captureDirectory))
    .some(row => row.type === 'session.text.delta'), 'controlled execution did not start');
  const plugins = await instance.plugins();
  assert.equal(plugins.find(plugin => plugin.id === 'synthetic.admission')?.state.status, 'active', JSON.stringify(plugins));
  const pending = (await instance.api('/api/session', { location: { directory: instance.projects[0] } })).data;
  const admission = instance.api(`/api/session/${pending.id}/prompt`, { text: 'SYNTHETIC_HELD_ADMISSION' })
    .then(value => ({ value }), error => ({ error }));
  await eventually(() => readFile(join(instance.root, 'admission-entered')), 'admission did not reach the public delaying hook');
  await rename(instance.captureDirectory, join(instance.root, 'preserved'));
  await writeFile(instance.captureDirectory, 'Synthetic destination failure');
  await instance.api(`/api/session/${session.id}`, { title: 'Barrera de fallo.' }, 'PATCH');
  await eventually(async () => (await instance.api(`/api/session/${session.id}`)).data.metadata
    ?.evagenticRecorder?.interruption.stop === 'confirmed', 'capture failure did not stop the running execution');
  await writeFile(join(instance.root, 'admission-release'), 'release');
  await admission;
  await instance.api(`/api/experimental/session/${pending.id}/wait`, {});
  const dispatches = await (await fetch(`${instance.simulationURL}/control/held-admissions`)).json();
  assert.equal(dispatches.count, 0, 'in-flight admission escaped the failed-recorder guard');
});

test('un cierre sin limpieza exige revisión aunque no pudiera guardar el fallo final', { timeout: 90000 }, async t => {
  const instance = await fixture(t, { simulation: true });
  const { data: session } = await instance.api('/api/session', { location: { directory: instance.projects[0] } });
  await instance.api(`/api/session/${session.id}/prompt`, { text: 'SYNTHETIC_LONG_RUNNING cierre abrupto' });
  await eventually(async () => (await records(instance.captureDirectory))
    .some(row => row.type === 'session.text.delta'), 'controlled execution did not start');
  await instance.restart(); // Terminate the isolated process; no recorder failure callback can run.
  const evidence = await records(instance.captureDirectory);
  await assert.rejects(instance.api(`/api/session/${session.id}/prompt`, { text: 'No ignorar el cierre sin limpieza.' }), /500:/);
  assert.deepEqual(await records(instance.captureDirectory), evidence);
  assert.equal((await instance.api(`/api/session/${session.id}`)).data.metadata.evagenticRecorder.reviewRequired, true);
});

test('un secreto en un identificador suministrado por el cliente no se persiste', { timeout: 90000 }, async t => {
  const instance = await fixture(t, { config: { secrets: ['synthetic-id-secret'] } });
  const { data: session } = await instance.api('/api/session', { location: { directory: instance.projects[0] } });
  await instance.api(`/api/session/${session.id}/prompt`, {
    id: 'msg_synthetic-id-secret', text: 'Texto permitido.', resume: false });
  const row = await eventually(async () => (await records(instance.captureDirectory))
    .find(row => row.type === 'session.inbox.enqueued'), 'admitted prompt was not persisted');
  assert.ok(!JSON.stringify(await records(instance.captureDirectory)).includes('synthetic-id-secret'));
  assert.equal(row.messageID, null);
  assert.ok(row.omissions.includes('unsafe-identifier'));
  assert.equal(row.content.text, 'Texto permitido.');
});
