import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rename, rm, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { eventually, fixture, records } from './support/instance.mjs';
import { appFetch, createExecution, executionDetail, launchExecution, launchWebapp, replyInteraction } from './support/webapp.mjs';
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
  const { app, configPath } = await launchWebapp(t, instance);

  const options = await appFetch(app, '/api/options');
  assert.equal(options.status, 200);
  assert.equal(options.body.state, 'ready');
  assert.ok(options.body.agents.some(agent => agent.id === 'synthetic-choice'));
  assert.ok(options.body.agents.some(agent => agent.id === 'build'));
  assert.ok(options.body.models.some(model => model.value === 'synthetic/synthetic#low'));
  assert.ok(options.body.commands.some(command => command.name === 'synthetic-echo'));
  assert.ok(options.body.commands.some(command => command.name === 'review'));

  const request = { requestKey: 'corte-27-uno',
    agent: 'synthetic-choice', model: 'synthetic/synthetic#low',
    command: { name: 'synthetic-echo', arguments: 'argumento-alfa valor-beta synthetic-secret-42',
      extra: { secret: 'synthetic-extra-secret' } } };
  const created = await launchExecution(app, request);
  assert.equal(created.status, 201);
  const id = created.body.execution.id;
  assert.equal(created.body.execution.requestedAgent, 'synthetic-choice');
  assert.equal(created.body.execution.requestedModel, 'synthetic/synthetic#low');
  assert.equal(created.body.execution.requestedCommand.name, 'synthetic-echo');
  assert.deepEqual(created.body.execution.requestedCommand, { name: 'synthetic-echo' });

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
  assert.equal(completed.conversation.entries[0].text, 'Encargo sintético de comando: argumento-alfa valor-beta [REDACTED]');
  assert.equal(completed.conversation.responses.length, 1);
  assert.match(completed.conversation.responses[0].text, /respuesta autorizada/i);

  const traffic = instance.simulationLog().split('\n').filter(Boolean).map(line => JSON.parse(line))
    .filter(event => event.event === 'request' && event.routeKey === 'model');
  assert.ok(traffic.length >= 1, 'no synthetic model traffic for the command execution');

  const retried = await launchExecution(app, request);
  assert.equal(retried.status, 200);
  assert.equal(retried.body.execution.id, id);
  const admitted = (await records(instance.captureDirectory)).filter(row =>
    row.type === 'session.inbox.enqueued' && row.content?.text === 'Encargo sintético de comando: argumento-alfa valor-beta [REDACTED]');
  assert.equal(admitted.length, 1, 'a repeated request key dispatched the command twice');
  const sessions = (await instance.api(
    `/api/session?directory=${encodeURIComponent(instance.projects[0])}`)).data;
  assert.equal(sessions.filter(session => (session.title ?? '').startsWith('Flujo en Proyecto ·')).length, 1,
    'the idempotent retry created a second root session');

  const indexPath = join(instance.root, 'webapp-data', 'executions.json');
  const index = await readFile(indexPath, 'utf8');
  for (const exposed of [index, JSON.stringify(completed), JSON.stringify((await appFetch(app, '/api/executions')).body)]) {
    assert.ok(!exposed.includes('synthetic-secret-42'));
    assert.ok(!exposed.includes('synthetic-extra-secret'));
    assert.ok(!exposed.includes('"arguments"'));
  }

  await rm(join(instance.root, 'config/opencode/commands/synthetic-echo.md'));
  await eventually(async () => !(await appFetch(app, '/api/options')).body.commands
    .some(command => command.name === 'synthetic-echo'), 'deleted command still listed', 30000);
  const vanishedRetry = await launchExecution(app, request);
  assert.equal(vanishedRetry.status, 200);
  assert.equal(vanishedRetry.body.execution.id, id);
  await instance.stop();
  const offlineRetry = await launchExecution(app, request);
  assert.equal(offlineRetry.status, 200);
  assert.equal(offlineRetry.body.execution.id, id);

  await app.close();
  const legacy = JSON.parse(index);
  legacy.executions[0].requestedCommand = request.command;
  const legacyText = JSON.stringify(legacy);
  await writeFile(indexPath, legacyText);
  const restarted = await startApp({ configPath });
  t.after(() => restarted.close());
  const legacyDetail = await executionDetail(restarted, id);
  assert.deepEqual(legacyDetail.body.execution.requestedCommand, { name: 'synthetic-echo' });
  for (const body of [legacyDetail.body, (await appFetch(restarted, '/api/executions')).body,
    (await launchExecution(restarted, request)).body]) {
    assert.ok(!JSON.stringify(body).includes('synthetic-secret-42'));
    assert.ok(!JSON.stringify(body).includes('synthetic-extra-secret'));
  }
  assert.equal(await readFile(indexPath, 'utf8'), legacyText, 'loading history must not destroy legacy evidence');
  const captureBefore = JSON.stringify(await records(instance.captureDirectory));
  assert.equal((await createExecution(restarted, 'legacy-next-offline', 'Otro encargo sintético.')).status, 201);
  const rewritten = await readFile(indexPath, 'utf8');
  assert.ok(!rewritten.includes('synthetic-secret-42'));
  assert.ok(!rewritten.includes('synthetic-extra-secret'));
  assert.ok(!rewritten.includes('"arguments"'));
  assert.equal(JSON.stringify(await records(instance.captureDirectory)), captureBefore,
    'sanitizing the app index must not modify recorder evidence');
});

test('un error 404 ajeno al comando conserva el envío posible y la exclusión', { timeout: 180000 }, async t => {
  const instance = await fixture(t, { ...selectionFixtureOptions, removeCommandSession: true });
  const { app } = await launchWebapp(t, instance);
  const options = await appFetch(app, '/api/options');
  assert.ok(options.body.commands.some(command => command.name === 'synthetic-echo'));
  const request = { requestKey: 'ambiguous-command', command: {
    name: 'synthetic-echo', arguments: 'Encargo sin sesión disponible.' } };
  const created = await launchExecution(app, request);
  assert.equal(created.status, 201);
  const sessionID = await eventually(async () => readFile(join(instance.root, 'command-session-removed'), 'utf8'),
    'the real plugin did not remove the session');
  const response = await fetch(`${instance.url()}/api/session/${sessionID}/command`, {
    method: 'POST', headers: { 'content-type': 'application/json',
      authorization: `Basic ${Buffer.from('opencode:synthetic-instance-password').toString('base64')}` },
    body: JSON.stringify({ name: 'synthetic-echo', text: request.command.arguments }),
  });
  const error = await response.text();
  assert.equal(response.status, 404, error);
  assert.ok(!error.includes('CommandNotFoundError'), error);
  await eventually(async () => (await executionDetail(app, created.body.execution.id))
    .body.execution.dispatch === 'possibly-sent', 'command was not attempted');
  const detail = await executionDetail(app, created.body.execution.id);
  assert.equal(detail.body.execution.status, 'pending');
  assert.equal(detail.body.execution.finishedAt, null);
  assert.equal((await createExecution(app, 'ambiguous-other', 'No debe lanzarse.')).status, 409);
  const retry = await launchExecution(app, request);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.execution.id, created.body.execution.id);
  assert.equal(await readFile(join(instance.root, 'command-session-removed'), 'utf8'), sessionID,
    'an ambiguous response must not create another root session');
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

const pendingInteraction = (app, id, filter) => eventually(async () => {
  const detail = (await executionDetail(app, id)).body;
  return detail.interactions?.pending?.find(filter) ?? undefined;
}, 'pending interaction was not surfaced');

const answerValue = field => {
  if (field.type === 'boolean') return true;
  if (field.type === 'number' || field.type === 'integer') return 1;
  const first = (field.options ?? [])[0];
  if (field.type === 'multiselect') return [first?.value ?? first?.label ?? 'Proceed'].filter(Boolean);
  return first?.value ?? first?.label ?? 'Continuar sintético';
};

test('la app responde preguntas y permisos nativos de la raíz y subejecuciones sin doble respuesta ni solicitudes ajenas',
  { timeout: 480000 }, async t => {
    const instance = await fixture(t, { simulation: true, syntheticTools: true,
      config: { secrets: ['synthetic-secret-42'] } });
    const { app, configPath } = await launchWebapp(t, instance);
    const created = await createExecution(app, 'intervencion-raiz', 'SYNTHETIC_HUMAN');
    assert.equal(created.status, 201);
    const id = created.body.execution.id;
    const root = await eventually(async () => {
      const sessionID = (await executionDetail(app, id)).body.execution.sessionID;
      return sessionID ?? undefined;
    }, 'root session was not confirmed');
    const rootQuestion = await pendingInteraction(app, id,
      item => item.kind === 'form' && item.sessionID === root);
    assert.ok(rootQuestion.requestID);
    assert.ok(rootQuestion.request.fields.length >= 1);
    assert.equal(typeof rootQuestion.request.title, 'string');
    const rootField = rootQuestion.request.fields[0];
    let detail = (await executionDetail(app, id)).body;
    assert.equal(detail.execution.status, 'running', 'an execution waiting for intervention was not running');
    assert.equal(detail.execution.sessionID, root);
    const rootRequest = (await records(instance.captureDirectory))
      .find(row => row.type === 'form.created' && row.sessionID === root);
    assert.equal(rootRequest.interaction.requestID, rootQuestion.requestID);

    const child = (await instance.api('/api/session', { parentID: root,
      location: { directory: instance.projects[0] },
      permissions: [{ action: 'synthetic.approval', resource: '*', effect: 'ask' }] })).data;
    await instance.api(`/api/session/${child.id}/prompt`, { text: 'SYNTHETIC_HUMAN' });
    const childQuestion = await pendingInteraction(app, id,
      item => item.kind === 'form' && item.sessionID === child.id);
    assert.notEqual(childQuestion.sessionID, root);
    const childField = childQuestion.request.fields[0];

    const foreign = (await instance.api('/api/session',
      { location: { directory: instance.projects[0] } })).data;
    const foreignForm = (await instance.api(`/api/session/${foreign.id}/form`, {
      title: 'Pregunta ajena sintética', fields: [{ key: 'answer', type: 'string' }] })).data;
    detail = (await executionDetail(app, id)).body;
    assert.ok(!detail.interactions.pending.some(item => item.sessionID === foreign.id),
      'a foreign interaction leaked into the execution detail');
    const foreignReply = await replyInteraction(app, id, { kind: 'form', sessionID: foreign.id,
      requestID: foreignForm.id, answer: { answer: 'Respuesta ajena' } });
    assert.equal(foreignReply.status, 403);
    assert.equal(foreignReply.body.error, 'session-not-in-execution');
    const foreignPending = (await instance.api(`/api/session/${foreign.id}/form`)).data;
    assert.equal(foreignPending.length, 1, 'a foreign interaction was answered from the app');
    assert.ok(!(await records(instance.captureDirectory))
      .some(row => row.type === 'form.replied' && row.sessionID === foreign.id));

    const unauthorized = await replyInteraction(app, id, { kind: 'form', sessionID: root,
      requestID: rootQuestion.requestID, answer: { [rootField.key]: 'x', ajeno: 'y' } });
    assert.equal(unauthorized.status, 400);
    assert.equal(unauthorized.body.error, 'answer-fields-not-authorized');
    const missing = await replyInteraction(app, id, { kind: 'form', sessionID: root,
      requestID: 'frm_missing', answer: { [rootField.key]: 'x' } });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, 'unknown-interaction');

    const childAnswer = await replyInteraction(app, id, { kind: 'form', sessionID: child.id,
      requestID: childQuestion.requestID, answer: { [childField.key]: answerValue(childField) } });
    assert.equal(childAnswer.status, 200);
    assert.equal(childAnswer.body.interaction.phase, 'replied');
    const childPermission = await pendingInteraction(app, id,
      item => item.kind === 'permission' && item.sessionID === child.id);
    assert.equal(childPermission.request.action, 'synthetic.approval');
    assert.deepEqual(childPermission.request.resources, ['Synthetic resource [REDACTED]']);
    const badDecision = await replyInteraction(app, id, { kind: 'permission', sessionID: child.id,
      requestID: childPermission.requestID, decision: 'forever' });
    assert.equal(badDecision.status, 400);
    assert.equal(badDecision.body.error, 'invalid-request');
    const childDecision = await replyInteraction(app, id, { kind: 'permission', sessionID: child.id,
      requestID: childPermission.requestID, decision: 'once' });
    assert.equal(childDecision.status, 200);

    await app.close();
    const restarted = await startApp({ configPath });
    t.after(() => restarted.close());
    const rebuilt = await pendingInteraction(restarted, id,
      item => item.kind === 'form' && item.sessionID === root);
    assert.equal(rebuilt.requestID, rootQuestion.requestID, 'a reload did not rebuild pending interactions');

    const rootAnswer = await replyInteraction(restarted, id, { kind: 'form', sessionID: root,
      requestID: rootQuestion.requestID, answer: { [rootField.key]: answerValue(rootField) } });
    assert.equal(rootAnswer.status, 200);
    const duplicated = await replyInteraction(restarted, id, { kind: 'form', sessionID: root,
      requestID: rootQuestion.requestID, answer: { [rootField.key]: answerValue(rootField) } });
    assert.equal(duplicated.status, 409);
    assert.equal(duplicated.body.error, 'interaction-resolved');
    const rootReplies = await eventually(async () => {
      const replies = (await records(instance.captureDirectory)).filter(row =>
        row.type === 'form.replied' && row.sessionID === root
        && row.interaction.requestID === rootQuestion.requestID);
      return replies.length ? replies : undefined;
    }, 'the root reply was not captured');
    assert.equal(rootReplies.length, 1, 'the same interaction was replied twice');

    const maybeRootPermission = await eventually(async () => {
      const current = (await executionDetail(restarted, id)).body;
      if (current.execution.status === 'succeeded') return 'closed';
      return current.interactions.pending.find(
        item => item.kind === 'permission' && item.sessionID === root) ?? false;
    }, 'the root neither finished nor asked for intervention', 30000).catch(() => false);
    if (maybeRootPermission !== 'closed' && maybeRootPermission !== false) {
      const rootDecision = await replyInteraction(restarted, id, { kind: 'permission',
        sessionID: root, requestID: maybeRootPermission.requestID, decision: 'once' });
      assert.equal(rootDecision.status, 200);
    }

    await eventually(async () => (await executionDetail(restarted, id)).body.execution.status === 'succeeded',
      'the execution did not continue after answering its interactions', 240000);
    detail = (await executionDetail(restarted, id)).body;
    assert.equal(detail.interactions.pending.length, 0);
    const resolvedChild = detail.interactions.resolved.find(item =>
      item.kind === 'form' && item.requestID === childQuestion.requestID);
    assert.ok(resolvedChild);
    const expectedAnswer = { [childField.key]: answerValue(childField) };
    assert.deepEqual(resolvedChild.response,
      JSON.parse(JSON.stringify(expectedAnswer).replaceAll('synthetic-secret-42', '[REDACTED]')));
    assert.ok(detail.interactions.resolved.some(item => item.kind === 'permission'
      && item.sessionID === child.id && item.response.decision === 'once'));
    assert.equal(detail.execution.id, id);
    if (maybeRootPermission !== 'closed' && maybeRootPermission !== false) {
      assert.ok(detail.interactions.resolved.some(item => item.kind === 'permission'
        && item.sessionID === root && item.requestID === maybeRootPermission.requestID));
    }
    const admitted = (await records(instance.captureDirectory)).filter(row =>
      row.type === 'session.inbox.enqueued' && row.sessionID === root && row.content?.role === 'user');
    assert.equal(admitted.length, 1, 'answering an interaction dispatched the assignment again');
    const sessions = (await instance.api(
      `/api/session?directory=${encodeURIComponent(instance.projects[0])}`)).data;
    assert.equal(sessions.filter(session =>
      (session.title ?? '').startsWith('Flujo en Proyecto ·')).length, 1,
      'answering an interaction created a second root session');
  });

test('responder con el motor caído falla de forma explícita sin conceder permisos ni relanzar',
  { timeout: 300000 }, async t => {
    const instance = await fixture(t, { simulation: true, syntheticTools: true });
    const { app } = await launchWebapp(t, instance);
    const created = await createExecution(app, 'intervencion-sin-motor', 'SYNTHETIC_HUMAN');
    assert.equal(created.status, 201);
    const id = created.body.execution.id;
    const root = await eventually(async () => {
      const sessionID = (await executionDetail(app, id)).body.execution.sessionID;
      return sessionID ?? undefined;
    }, 'root session was not confirmed');
    const question = await pendingInteraction(app, id,
      item => item.kind === 'form' && item.sessionID === root);
    const field = question.request.fields[0];

    await instance.stop();
    const reply = await replyInteraction(app, id, { kind: 'form', sessionID: root,
      requestID: question.requestID, answer: { [field.key]: answerValue(field) } });
    assert.equal(reply.status, 503);
    assert.equal(reply.body.error, 'engine-unreachable');
    const evidence = await records(instance.captureDirectory);
    assert.ok(!evidence.some(row => row.type === 'form.replied' && row.sessionID === root),
      'an unreachable engine produced a reply');
    const detail = (await executionDetail(app, id)).body;
    assert.equal(detail.execution.status, 'running');
    assert.equal(detail.interactions.pending.length, 1, 'the visible wait was lost with the engine down');
    assert.deepEqual(detail.interactions.readErrors, [{ error: 'engine-unreachable' }]);
    assert.notEqual((await createExecution(app, 'intervencion-otro', 'No debe lanzarse.')).status, 201,
      'a failed reply released the project');
  });
