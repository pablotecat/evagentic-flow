import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
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

test('un destino no escribible no se presenta como preparado', { timeout: 90000 }, async t => {
  const instance = await fixture(t, { config: async ({ root }) => {
    const blocked = join(root, 'blocked');
    await writeFile(blocked, 'Not a directory');
    return { captureDirectory: blocked };
  } });
  const { data: session } = await instance.api('/api/session', { location: { directory: instance.projects[0] } });
  await instance.api(`/api/session/${session.id}/prompt`, { text: 'Preparation only', resume: false });
  const plugin = await eventually(async () => (await instance.plugins()).find(row => row.id === 'evagentic.recorder'),
    'failed recorder was not reported');
  assert.equal(plugin.state.status, 'failed');
  assert.deepEqual(await records(instance.captureDirectory), []);
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
