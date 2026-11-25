import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rename, rm, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { eventually, fixture, records } from './support/instance.mjs';
import { appFetch, createExecution, executionDetail, launchExecution, launchWebapp } from './support/webapp.mjs';
import { startApp } from '../webapp/server.mjs';

test('el cleanup cierra la app incluso si una aserción falla antes del cierre explícito', async () => {
  const temporary = process.env.OPENCODE_TEST_TMP ?? (process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA, 'Temp/opencode') : tmpdir());
  const root = await mkdtemp(join(temporary, 'webapp-cleanup-'));
  const project = join(root, 'project');
  await mkdir(project);
  const script = `
    import test from 'node:test';
    import assert from 'node:assert/strict';
    import { launchWebapp } from ${JSON.stringify(new URL('./support/webapp.mjs', import.meta.url).href)};
    test('synthetic early failure', async t => {
      await launchWebapp(t, { root: ${JSON.stringify(root)}, projects: [${JSON.stringify(project)}],
        captureDirectory: ${JSON.stringify(join(root, 'capture'))}, url: () => 'http://127.0.0.1:1' });
      assert.fail('synthetic assertion before explicit app.close');
    });
  `;
  const result = await new Promise(resolve => execFile(process.execPath,
    ['--input-type=module', '--eval', script], { timeout: 15000 },
    (error, stdout, stderr) => resolve({ error, stdout, stderr })));
  assert.equal(result.error?.killed, false, result.stderr);
  assert.equal(result.error?.code, 1, 'the failed assertion must remain a normal test failure, not a hung server');
  assert.match(result.stdout + result.stderr, /synthetic assertion before explicit app.close/);
  await assert.rejects(readFile(join(root, 'webapp-data', 'index-review-required')), { code: 'ENOENT' });
});

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
  assert.equal(completed.execution.dispatch, 'admitted');
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
  assert.equal(retried.body.execution.status, 'pending');
  assert.equal(retried.body.execution.dispatch, 'possibly-sent');
  assert.equal(retried.body.execution.dispatchedAt, null);
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
  assert.equal(detail.body.execution.status, 'pending');
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
  assert.equal(withoutEngine.body.execution.status, 'pending');
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

test('la misma clave sigue siendo idempotente al reconciliar el cierre anterior', { timeout: 180000 }, async t => {
  const instance = await fixture(t, { simulation: true });
  const { app } = await launchWebapp(t, instance);
  const previous = await createExecution(app, 'race-previous', 'Encargo previo sintético.');
  await eventually(async () => (await records(instance.captureDirectory))
    .some(row => row.type === 'session.execution.succeeded'), 'previous assignment did not finish');
  const responses = await Promise.all(Array.from({ length: 8 }, () =>
    createExecution(app, 'race-same-key', 'Encargo repetido tras cierre.')));
  assert.equal(responses.filter(response => response.status === 201).length, 1);
  assert.equal(responses.filter(response => response.status === 200).length, 7);
  const ids = new Set(responses.map(response => response.body.execution.id));
  assert.equal(ids.size, 1);
  assert.ok(!ids.has(previous.body.execution.id));
  const id = responses[0].body.execution.id;
  await eventually(async () => (await executionDetail(app, id)).body.execution.status === 'succeeded',
    'raced assignment did not finish');
  const admissions = (await records(instance.captureDirectory)).filter(row => row.type === 'session.inbox.enqueued');
  assert.equal(admissions.length, 2);
});

test('el cierre de la raíz no libera un árbol activo ni una pregunta pendiente', { timeout: 240000 }, async t => {
  const instance = await fixture(t, { simulation: true, admissionGate: true });
  const { app } = await launchWebapp(t, instance);
  const created = await createExecution(app, 'tree-root', 'SYNTHETIC_HELD_ADMISSION');
  const id = created.body.execution.id;
  const root = await eventually(async () => (await executionDetail(app, id)).body.execution.sessionID,
    'missing root session');
  await eventually(async () => readFile(join(instance.root, 'admission-entered'), 'utf8'), 'admission gate not entered');
  const child = (await instance.api('/api/session', { parentID: root,
    location: { directory: instance.projects[0] } })).data;
  await instance.api(`/api/session/${child.id}/prompt`, { text: 'SYNTHETIC_LONG_RUNNING' });
  await eventually(async () => (await records(instance.captureDirectory))
    .some(row => row.sessionID === child.id && row.type === 'session.text.delta'), 'child did not start');
  await writeFile(join(instance.root, 'admission-release'), 'release');
  await eventually(async () => (await records(instance.captureDirectory))
    .some(row => row.sessionID === root && row.type === 'session.execution.succeeded'), 'root did not finish');
  assert.equal((await executionDetail(app, id)).body.execution.status, 'running');
  assert.equal((await createExecution(app, 'tree-other', 'No debe despacharse.')).status, 409);
  const form = (await instance.api(`/api/session/${root}/form`, {
    title: 'Synthetic pending question', fields: [{ key: 'answer', type: 'string' }] })).data;
  await instance.api(`/api/session/${child.id}/interrupt`, { resume: false });
  await instance.api(`/api/experimental/session/${child.id}/wait`, {});
  await eventually(async () => (await records(instance.captureDirectory))
    .some(row => row.sessionID === child.id && row.type === 'session.execution.interrupted'), 'child did not stop');
  await eventually(async () => {
    const detail = (await executionDetail(app, id)).body;
    const rows = (await records(instance.captureDirectory)).filter(row => [root, child.id].includes(row.sessionID));
    const lastObserved = rows.reduce((latest, row) => Math.max(latest, row.observedAt), 0);
    assert.deepEqual(new Set(detail.capture.scope.sessionIDs), new Set([root, child.id]));
    assert.equal(detail.capture.scope.kind, 'observed-session-tree');
    assert.equal(detail.capture.scope.rootSessionID, root);
    assert.ok(detail.capture.omissions.some(row => row.sessionID === child.id));
    return detail.capture.horizon === new Date(lastObserved).toISOString();
  }, 'the public evidence horizon did not include the observed descendant');
  assert.equal((await executionDetail(app, id)).body.execution.status, 'running');
  assert.equal((await createExecution(app, 'tree-question', 'No debe despacharse.')).status, 409);
  await instance.api(`/api/session/${root}/form/${form.id}/reply`, { answer: { answer: 'Synthetic answer' } });
  await eventually(async () => (await executionDetail(app, id)).body.execution.status === 'succeeded',
    'resolved tree did not reach technical completion');
});

test('el cierre no oculta un permiso pendiente en un descendiente', { timeout: 240000 }, async t => {
  const instance = await fixture(t, { simulation: true, syntheticTools: true, admissionGate: true });
  const { app } = await launchWebapp(t, instance);
  const created = await createExecution(app, 'permission-root', 'SYNTHETIC_HELD_ADMISSION');
  const id = created.body.execution.id;
  const root = await eventually(async () => (await executionDetail(app, id)).body.execution.sessionID,
    'missing root session');
  const child = (await instance.api('/api/session', { parentID: root,
    location: { directory: instance.projects[0] },
    permissions: [{ action: 'synthetic.approval', resource: '*', effect: 'ask' }] })).data;
  await instance.api(`/api/session/${child.id}/prompt`, { text: 'SYNTHETIC_HUMAN' });
  const form = await eventually(async () => (await instance.api(`/api/session/${child.id}/form`)).data[0],
    'missing descendant question');
  await instance.api(`/api/session/${child.id}/form/${form.id}/reply`, {
    answer: { [form.fields[0].key]: 'Proceed synthetic-secret-42' } });
  const permission = await eventually(async () => (await instance.api(`/api/session/${child.id}/permission`)).data[0],
    'missing pending permission');
  await writeFile(join(instance.root, 'admission-release'), 'release');
  await eventually(async () => (await records(instance.captureDirectory))
    .some(row => row.sessionID === root && row.type === 'session.execution.succeeded'), 'root did not finish');
  assert.equal((await executionDetail(app, id)).body.execution.status, 'running');
  assert.equal((await createExecution(app, 'permission-other', 'No debe despacharse.')).status, 409);
  await instance.api(`/api/session/${child.id}/permission/${permission.id}/reply`, { decision: 'once' });
  await eventually(async () => (await executionDetail(app, id)).body.execution.status === 'succeeded',
    'approved tree did not finish');
});

for (const failureTarget of ['index', 'directory']) test(`un fallo real de ${failureTarget} no publica cierre ni libera y exige revisión incluso tras reparar y reiniciar`,
  { timeout: 240000 }, async t => {
    const instance = await fixture(t, { simulation: true });
    const { app, configPath } = await launchWebapp(t, instance);
    const created = await createExecution(app, 'index-root', 'SYNTHETIC_LONG_RUNNING');
    const id = created.body.execution.id;
    await eventually(async () => (await executionDetail(app, id)).body.execution.dispatch === 'admitted',
      'admission not confirmed');
    const root = (await executionDetail(app, id)).body.execution.sessionID;
    const index = join(instance.root, 'webapp-data', 'executions.json');
    const target = failureTarget === 'index' ? index : join(instance.root, 'webapp-data');
    const preserved = `${target}.preserved`;
    await rename(target, preserved);
    if (failureTarget === 'index') await mkdir(target);
    else await writeFile(target, 'Synthetic lost data directory');
    await instance.api(`/api/session/${root}/interrupt`, { resume: false });
    await instance.api(`/api/experimental/session/${root}/wait`, {});
    await eventually(async () => (await records(instance.captureDirectory))
      .some(row => row.sessionID === root && row.type === 'session.execution.interrupted'), 'root did not stop');
    await eventually(async () => (await executionDetail(app, id)).status === 500,
      'failed index write was not reported');
    const failed = await executionDetail(app, id);
    assert.equal(failed.body.execution.status, 'running');
    assert.equal(failed.body.execution.finishedAt, null);
    assert.equal((await appFetch(app, '/api/health')).body.index.status, 'review-required');
    assert.equal((await createExecution(app, 'index-other', 'No debe despacharse.')).status, 503);
    if (failureTarget === 'index') await rmdir(target);
    else await unlink(target);
    await rename(preserved, target);
    assert.equal((await executionDetail(app, id)).body.execution.status, 'running');
    assert.equal((await createExecution(app, 'index-other', 'No debe despacharse.')).status, 503);
    await app.close();
    const restarted = await startApp({ configPath });
    t.after(() => restarted.close());
    assert.equal((await executionDetail(restarted, id)).body.execution.status, 'running');
    assert.equal((await createExecution(restarted, 'index-other', 'No debe despacharse.')).status, 503);
    const retry = await createExecution(restarted, 'index-root', 'SYNTHETIC_LONG_RUNNING');
    assert.equal(retry.status, 200);
    assert.equal(retry.body.execution.id, id);
    const admitted = (await records(instance.captureDirectory)).filter(row => row.type === 'session.inbox.enqueued');
    assert.equal(admitted.length, 1);
  });

const selectionFixtureOptions = {
  simulation: true,
  syntheticCommands: true,
  config: { secrets: ['synthetic-secret-42'] },
  serverConfig: {
    agents: {
      'synthetic-choice': {
        mode: 'all',
        description: 'Agente sintético de selección',
        system: 'Instrucciones sintéticas del agente elegido.',
      },
    },
  },
};

test('la app expone opciones de la instancia y lanza un encargo con agente, modelo y comando elegidos', { timeout: 300000 }, async t => {
  const instance = await fixture(t, selectionFixtureOptions);
  const { app } = await launchWebapp(t, instance);

  const options = await appFetch(app, '/api/options');
  assert.equal(options.status, 200);
  assert.equal(options.body.state, 'ready');
  assert.ok(options.body.agents.some(agent => agent.id === 'synthetic-choice'));
  assert.ok(options.body.agents.some(agent => agent.id === 'build'));
  assert.ok(options.body.models.some(model => model.value === 'synthetic/synthetic#low'));
  assert.ok(options.body.commands.some(command => command.name === 'synthetic-echo'));
  assert.ok(options.body.commands.some(command => command.name === 'review'));

  const created = await launchExecution(app, { requestKey: 'corte-27-uno',
    agent: 'synthetic-choice', model: 'synthetic/synthetic#low',
    command: { name: 'synthetic-echo', arguments: 'argumento-alfa valor-beta' } });
  assert.equal(created.status, 201);
  const id = created.body.execution.id;
  assert.equal(created.body.execution.requestedAgent, 'synthetic-choice');
  assert.equal(created.body.execution.requestedModel, 'synthetic/synthetic#low');
  assert.equal(created.body.execution.requestedCommand.name, 'synthetic-echo');

  const completed = await eventually(async () => {
    const detail = await executionDetail(app, id);
    return detail.body.execution.status === 'succeeded' ? detail.body : undefined;
  }, 'launched command execution did not reach a technical completion', 120000);
  assert.equal(completed.execution.dispatch, 'admitted');
  assert.equal(completed.execution.knownAgent, 'synthetic-choice');
  assert.equal(completed.execution.knownAgentSource, 'public-session');
  assert.equal(completed.execution.knownModel.value, 'synthetic/synthetic#low');
  assert.equal(completed.execution.knownModelSource, 'public-session');
  assert.ok(completed.execution.selectionObservedAt);
  assert.equal(completed.conversation.entries.length, 1);
  assert.equal(completed.conversation.entries[0].text, 'Encargo sintético de comando: argumento-alfa valor-beta');
  assert.equal(completed.conversation.responses.length, 1);
  assert.match(completed.conversation.responses[0].text, /respuesta autorizada/i);

  const traffic = instance.simulationLog().split('\n').filter(Boolean).map(line => JSON.parse(line))
    .filter(event => event.event === 'request' && event.routeKey === 'model');
  assert.ok(traffic.length >= 1, 'no synthetic model traffic for the command execution');

  const retried = await launchExecution(app, { requestKey: 'corte-27-uno',
    agent: 'synthetic-choice', model: 'synthetic/synthetic#low',
    command: { name: 'synthetic-echo', arguments: 'argumento-alfa valor-beta' } });
  assert.equal(retried.status, 200);
  assert.equal(retried.body.execution.id, id);
  const admitted = (await records(instance.captureDirectory)).filter(row =>
    row.type === 'session.inbox.enqueued' && row.content?.text === 'Encargo sintético de comando: argumento-alfa valor-beta');
  assert.equal(admitted.length, 1, 'a repeated request key dispatched the command twice');
  const sessions = (await instance.api(
    `/api/session?directory=${encodeURIComponent(instance.projects[0])}`)).data;
  assert.equal(sessions.filter(session => (session.title ?? '').startsWith('Flujo en Proyecto ·')).length, 1,
    'the idempotent retry created a second root session');
});

test('una opción elegida que no está expuesta se rechaza explícitamente sin despachar el encargo', { timeout: 300000 }, async t => {
  const instance = await fixture(t, selectionFixtureOptions);
  const { app } = await launchWebapp(t, instance);
  const before = (await instance.api(
    `/api/session?directory=${encodeURIComponent(instance.projects[0])}`)).data.length;

  for (const selection of [
    { agent: 'missing-agent', body: { text: 'Encargo con agente incompatible.' } },
    { model: 'missing/model', body: { text: 'Encargo con modelo incompatible.' } },
    { commandName: 'missing-command', body: { command: { name: 'missing-command', arguments: 'x' } } },
  ]) {
    const rejected = await launchExecution(app, { requestKey: `corte-27-rechazo-${selection.agent ?? selection.model ?? selection.commandName}`,
      ...selection.body, ...(selection.agent ? { agent: selection.agent } : {}), ...(selection.model ? { model: selection.model } : {}) });
    assert.equal(rejected.status, 422);
    assert.equal(rejected.body.error, 'selection-unavailable');
  }

  assert.equal((await appFetch(app, '/api/executions')).body.executions.length, 0,
    'a rejected selection created an execution');
  const admitted = (await records(instance.captureDirectory)).filter(row =>
    row.type === 'session.inbox.enqueued' && row.content?.role === 'user');
  assert.equal(admitted.length, 0, 'a rejected selection dispatched work');
  const sessions = (await instance.api(
    `/api/session?directory=${encodeURIComponent(instance.projects[0])}`)).data;
  assert.equal(sessions.length, before, 'a rejected selection created a session');

  await rm(join(instance.root, 'config/opencode/commands/synthetic-echo.md'));
  const gone = await eventually(async () => {
    const options = await appFetch(app, '/api/options');
    return options.body.commands.some(command => command.name === 'synthetic-echo') ? undefined : options.body.commands;
  }, 'the deleted synthetic command stayed listed', 30000);
  assert.ok(gone.some(command => command.name === 'review'));

  const vanished = await launchExecution(app, { requestKey: 'corte-27-desaparecido',
    command: { name: 'synthetic-echo', arguments: 'no debe despacharse' } });
  assert.equal(vanished.status, 422);
  assert.equal(vanished.body.error, 'selection-unavailable');
  assert.equal(vanished.body.kind, 'command');
  assert.equal((await appFetch(app, '/api/executions')).body.executions.length, 0,
    'a vanished command created an execution');

  const valid = await launchExecution(app, { requestKey: 'corte-27-valido',
    command: { name: 'review', arguments: 'encargo tras la opción desaparecida' } });
  assert.equal(valid.status, 201, 'a vanished option left the project locked');
  await eventually(async () => (await executionDetail(app, valid.body.execution.id))
    .body.execution.status === 'succeeded', 'execution after the vanished option did not complete', 120000);

  await instance.stop();
  const offline = await appFetch(app, '/api/options');
  assert.equal(offline.status, 200);
  assert.equal(offline.body.state, 'engine-unreachable');
  assert.equal(offline.body.agents, null);
});
