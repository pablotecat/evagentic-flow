import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { eventually, fixture, records } from './support/instance.mjs';
import { appFetch, createExecution, executionDetail, launchWebapp } from './support/webapp.mjs';
import { startApp } from '../webapp/server.mjs';

test('la app lanza una ejecución desde su API y conserva el resultado autorizado', { timeout: 300000 }, async t => {
  const instance = await fixture(t, { simulation: true, config: { secrets: ['synthetic-secret-42'] } });
  const { app, configPath } = await launchWebapp(t, instance);
  const first = await createExecution(app, 'corte-25-uno', 'Encargo sintético del corte. clave synthetic-secret-42.');
  assert.equal(first.status, 201);
  const executionId = first.body.execution.id;
  assert.ok(executionId);
  const completed = await eventually(async () => {
    const detail = await executionDetail(app, executionId);
    return detail.body.execution.status === 'succeeded' ? detail.body : undefined;
  }, 'launched execution did not reach a technical completion', 120000);
  assert.equal(completed.execution.dispatch, 'session-confirmed');
  assert.notEqual(completed.execution.sessionID, executionId);
  assert.match(completed.execution.sessionID, /^ses_/);
  assert.match(completed.execution.promptMessageID, /^msg_/);
  assert.equal(completed.conversation.entries.length, 1);
  assert.equal(completed.conversation.entries[0].text, 'Encargo sintético del corte. clave [REDACTED].');
  assert.equal(completed.conversation.responses.length, 1);
  assert.equal(completed.conversation.responses[0].text, 'Respuesta autorizada. clave [REDACTED].');
  assert.ok(completed.capture.readable);
  assert.ok(completed.capture.captureIDs.length >= 1);
  assert.ok(completed.capture.captureIDs.every(captureID => captureID !== completed.execution.sessionID));
  const retried = await createExecution(app, 'corte-25-uno', 'Encargo sintético del corte. clave synthetic-secret-42.');
  assert.equal(retried.status, 200);
  assert.equal(retried.body.execution.id, executionId);
  const admitted = (await records(instance.captureDirectory)).filter(row =>
    row.type === 'session.inbox.enqueued' && row.content?.role === 'user');
  assert.equal(admitted.length, 1, 'a repeated request key dispatched the assignment twice');

  const held = await createExecution(app, 'corte-25-held', 'SYNTHETIC_HELD_ADMISSION');
  assert.equal(held.status, 201);
  await eventually(async () => (await executionDetail(app, held.body.execution.id))
    .body.execution.sessionID !== null, 'held execution did not confirm its root session');
  const rejected = await createExecution(app, 'corte-25-otro', 'Encargo durante ocupación.');
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.error, 'project-busy');
  assert.equal(rejected.body.execution.id, held.body.execution.id);
  await writeFile(join(instance.root, 'admission-release'), 'release');
  await eventually(async () => (await executionDetail(app, held.body.execution.id))
    .body.execution.status === 'succeeded', 'held execution did not complete after release', 120000);
  const afterBusy = await createExecution(app, 'corte-25-final', 'Encargo tras liberar el proyecto.');
  assert.equal(afterBusy.status, 201);

  await app.close();
  const restarted = await startApp({ configPath });
  t.after(() => restarted.close());
  const listed = await appFetch(restarted, '/api/executions');
  assert.equal(listed.status, 200);
  const keys = listed.body.executions.map(execution => execution.requestKey);
  for (const key of ['corte-25-uno', 'corte-25-held', 'corte-25-final']) {
    assert.ok(keys.includes(key), `history lost ${key} after restart`);
  }
  const persisted = await executionDetail(restarted, executionId);
  assert.equal(persisted.body.execution.status, 'succeeded');
  assert.equal(persisted.body.conversation.entries[0].text, 'Encargo sintético del corte. clave [REDACTED].');
  assert.equal(persisted.body.conversation.responses[0].text, 'Respuesta autorizada. clave [REDACTED].');
  await instance.stop();
  const withoutEngine = await executionDetail(restarted, executionId);
  assert.equal(withoutEngine.body.execution.status, 'succeeded');
  assert.equal(withoutEngine.body.conversation.responses[0].text, 'Respuesta autorizada. clave [REDACTED].');
  const health = await appFetch(restarted, '/api/health');
  assert.equal(health.body.engine.reachable, false);
  assert.equal(health.body.capture.status, 'prepared');
});

test('un desenlace sin comprobar permanece pendiente y no reenvía el trabajo', { timeout: 300000 }, async t => {
  const instance = await fixture(t, { simulation: true, admissionGate: true });
  const { app, configPath } = await launchWebapp(t, instance);
  const held = await createExecution(app, 'perdido-uno', 'SYNTHETIC_HELD_ADMISSION');
  assert.equal(held.status, 201);
  let heldSession = null;
  await eventually(async () => {
    const detail = await executionDetail(app, held.body.execution.id);
    return detail.body.execution.sessionID !== null ? heldSession = detail.body.execution : undefined;
  }, 'held execution did not confirm its root session');
  const rejected = await createExecution(app, 'perdido-dos', 'Encargo durante ocupación.');
  assert.equal(rejected.status, 409);

  await app.close();
  const restarted = await startApp({ configPath });
  t.after(() => restarted.close());
  const retried = await createExecution(restarted, 'perdido-uno', 'SYNTHETIC_HELD_ADMISSION');
  assert.equal(retried.status, 200);
  assert.equal(retried.body.execution.id, held.body.execution.id);
  assert.equal(retried.body.execution.sessionID, heldSession.sessionID);
  assert.equal(retried.body.execution.status, 'running');
  const rejectedAfterRestart = await createExecution(restarted, 'perdido-dos', 'Encargo durante ocupación.');
  assert.equal(rejectedAfterRestart.status, 409);

  await writeFile(join(instance.root, 'admission-release'), 'release');
  await instance.api(`/api/experimental/session/${heldSession.sessionID}/wait`, {});
  await assert.rejects(eventually(async () => {
    const modelTraffic = instance.simulationLog().split('\n').filter(Boolean).map(line => JSON.parse(line))
      .filter(event => event.event === 'request' && event.routeKey === 'model');
    return modelTraffic.length > 0 ? modelTraffic : undefined;
  }, 'no synthetic model traffic', 15000), /no synthetic model traffic/);
  const detail = await executionDetail(restarted, held.body.execution.id);
  assert.equal(detail.body.execution.status, 'running');
  assert.equal(detail.body.execution.sessionID, heldSession.sessionID);
  const admitted = (await records(instance.captureDirectory)).filter(row =>
    row.type === 'session.inbox.enqueued' && row.content?.role === 'user');
  assert.equal(admitted.length, 0, 'a possibly lost dispatch left admitted work behind');
  const sessions = (await instance.api(
    `/api/session?directory=${encodeURIComponent(instance.projects[0])}`)).data;
  assert.equal(sessions.filter(session => (session.title ?? '').startsWith('Flujo en Proyecto ·')).length, 1,
    'the app created a second root session for a possibly lost dispatch');
  const stillBusy = await createExecution(restarted, 'perdido-tres', 'Encargo tras perder el despacho.');
  assert.equal(stillBusy.status, 409, 'an unchecked outcome released the project');

  await instance.stop();
  const withoutEngine = await executionDetail(restarted, held.body.execution.id);
  assert.equal(withoutEngine.body.execution.status, 'running');
  assert.equal(withoutEngine.body.conversation.entries.length, 0);
});

test('la app rechaza peticiones ajenas y valida la creación', { timeout: 90000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'webapp-app-'));
  const projectDirectory = join(root, 'project');
  await mkdir(projectDirectory, { recursive: true });
  const socket = net.createServer(client => client.destroy());
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => socket.close(resolve)));
  const deadPort = socket.address().port;
  const configPath = join(root, 'webapp.local.json');
  await writeFile(configPath, JSON.stringify({ version: 1,
    opencodeURL: `http://127.0.0.1:${deadPort}`, opencodePassword: 'synthetic-opencode-password',
    projectDirectory, captureDirectory: join(root, 'captures'), dataDirectory: join(root, 'data') }));
  const app = await startApp({ configPath });
  t.after(() => app.close());

  const post = (headers, body = JSON.stringify({ requestKey: 'seg-uno', text: 'Encargo sintético.' })) =>
    new Promise(resolve => {
      const request = http.request(app.url, { method: 'POST', path: '/api/executions', headers: {
        'content-type': 'application/json', ...headers } }, response => {
        let text = '';
        response.on('data', chunk => { text += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, body: text ? JSON.parse(text) : null }));
      });
      request.end(body);
    });

  assert.equal((await post({ origin: 'https://evil.example' })).status, 403);
  assert.equal((await post({ host: 'evil.example' })).status, 403);
  assert.equal((await post({}, '{}')).status, 400);
  assert.equal((await appFetch(app, '/api/executions/unknown')).status, 404);

  const created = await post({});
  assert.equal(created.status, 201);
  await eventually(async () => (await executionDetail(app, created.body.execution.id))
    .body.execution.status === 'pending', 'unreachable engine did not leave a pending execution');
  const detail = await executionDetail(app, created.body.execution.id);
  assert.equal(detail.body.execution.dispatch, 'unconfirmed');
  assert.equal(detail.body.execution.sessionID, null);
  assert.equal(detail.body.capture.reason, 'session-not-confirmed');
  const retried = await createExecution(app, 'seg-uno', 'Encargo sintético.');
  assert.equal(retried.status, 200);
  assert.equal(retried.body.execution.id, created.body.execution.id);
  const listed = await appFetch(app, '/api/executions');
  assert.equal(listed.body.executions.length, 1, 'an unreachable engine produced duplicate executions');
  const health = await appFetch(app, '/api/health');
  assert.equal(health.body.engine.reachable, false);
  assert.notEqual(health.body.capture.status, 'prepared');

  const page = await fetch(app.url);
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes('Flujo en Proyecto'));
});
